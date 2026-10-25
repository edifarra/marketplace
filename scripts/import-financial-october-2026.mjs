import nextEnv from '@next/env';
import { createClient } from '@supabase/supabase-js';
import { randomUUID, createHmac } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { START, period, inPeriod, sha, parseLossless, decimal, signed, amounts, reportRows, reportMovementDate } from './financial-import-core.mjs';

nextEnv.loadEnvConfig(process.cwd(), false, { info() {}, error() {} });
const args = process.argv.slice(2);
if (args.some(a => !['--write','--generate-reports','--dry-run','--replay-check'].includes(a) && !a.startsWith('--end=') && !a.startsWith('--report=') && !a.startsWith('--accounts='))) throw new Error('Unknown argument');
const write = args.includes('--write');
if (write && args.includes('--dry-run')) throw new Error('Choose write or dry-run');
if (args.includes('--generate-reports') && !write) throw new Error('Report creation requires --write');
const window = period(args.find(a => a.startsWith('--end='))?.slice(6) || new Date(Math.min(Date.now(), Date.parse('2026-10-26T03:00:00Z'))).toISOString());
const reportPath = args.find(a => a.startsWith('--report='))?.slice(9);
const selectedAccounts = args.find(a => a.startsWith('--accounts='))?.slice(11).split(',');
if (selectedAccounts?.some(name => !['ML-ED','ML-GI','SP-ED','SP-GI'].includes(name))) throw new Error('Unknown account');
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
if (new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname !== 'ukfefrdaivqzxeeknmqr.supabase.co') throw new Error('Unexpected Supabase project');
const runId = randomUUID();
let pendingRows = [];
const summary = { runId, mode: write ? 'write' : 'dry-run', window, accounts: [], collectorVersion: '1' };
const { data: accounts, error } = await db.from('config_marketplace_accounts').select('id,name,marketplace,active,access_token,token_expires_at,seller_id,shop_id,account_id,client_id,client_secret,api_base_url');
if (error) throw new Error(`Account read failed: ${error.code}`);
if (accounts.length !== 4 || new Set(accounts.map(a => a.name)).size !== 4 || accounts.some(a => !['ML-ED','ML-GI','SP-ED','SP-GI'].includes(a.name))) throw new Error('Expected exactly four known accounts');
if (write) await checked(db.from('financial_import_runs').insert({ id: runId, period_start: window.start, period_end: window.end, collector_version: '1', status: 'running' }));

async function checked(query) { const result = await query; if (result.error) throw new Error(`Database operation failed: ${result.error.code} ${result.error.message}`); return result.data; }
async function request(a, source, path, params = {}, method = 'GET', body, retry = true) {
  if (!a.access_token) throw new Error('Stored OAuth token missing');
  if (Date.parse(a.token_expires_at) <= Date.now()) {
    if (retry && await reloadToken(a)) return request(a, source, path, params, method, body, false);
    throw new Error('Stored OAuth token expired; renew through existing authorized connection flow');
  }
  const shopee = a.marketplace === 'shopee';
  const host = shopee ? 'https://partner.shopeemobile.com' : source.startsWith('ml_') ? 'https://api.mercadolibre.com' : 'https://api.mercadopago.com';
  const url = new URL(path, host);
  if (url.origin !== host) throw new Error('Unexpected API host');
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  if (shopee) {
    const timestamp = Math.floor(Date.now() / 1000), partner = a.client_id || process.env.SHOPEE_PARTNER_ID, key = a.client_secret || process.env.SHOPEE_PARTNER_KEY, shop = a.shop_id || a.account_id;
    if (!partner || !key || !shop) throw new Error('Shopee signing configuration missing');
    const sign = createHmac('sha256', key).update('' + partner + path + timestamp + a.access_token + shop).digest('hex');
    for (const [k, v] of Object.entries({ partner_id: partner, timestamp, access_token: a.access_token, shop_id: shop, sign })) url.searchParams.set(k, String(v));
  }
  const response = await fetch(url, { method, redirect: 'error', headers: { ...(shopee ? {} : { Authorization: 'Bearer ' + a.access_token }), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(45000) });
  const bytes = Buffer.from(await response.arrayBuffer()), text = bytes.toString('utf8');
  const evidence = { id: randomUUID(), run_id: runId, account_id: a.id, source, endpoint: host + path, request_parameters: { method, query: params, ...(body ? { body } : {}) }, http_status: response.status, collected_at: new Date().toISOString(), response_headers: Object.fromEntries(['content-type','content-disposition','x-request-id','x-correlation-id','date'].map(k => [k, response.headers.get(k)])), body_base64: bytes.toString('base64'), body_sha256: sha(bytes) };
  if (write) await checked(db.from('financial_api_responses').insert(evidence));
  let json; try { json = parseLossless(text); } catch { /* CSV/binary report: exact bytes are retained. */ }
  const ok = response.ok && !json?.error;
  if (!ok && method === 'GET' && retry && [401,403].includes(response.status) && await reloadToken(a)) return request(a, source, path, params, method, body, false);
  if (!ok) throw new Error(`${source} ${path}: HTTP ${response.status}; ${json?.error || json?.message || 'non-JSON error'}`);
  return { json, text, evidence };
}
async function reloadToken(account) {
  const { data, error } = await db.from('config_marketplace_accounts').select('access_token,token_expires_at').eq('id', account.id).single();
  if (error || !data?.access_token || data.access_token === account.access_token) return false;
  // The existing worker may rotate tokens while a manual collection is running.
  // Reload only; this importer never renews or writes existing credentials.
  Object.assign(account, data); return true;
}

async function save(a, source, semantic, externalId, date, dateBasis, currency, amount, sign, payload, evidence, raw = null) {
  if (!inPeriod(date, window)) return { excluded: 1 };
  if (!externalId) throw new Error(`${source}: missing identity`);
  const digest = sha(JSON.stringify(payload));
  const row = { id: randomUUID(), account_id: a.id, account_name: a.name, source, semantic, external_id: String(externalId), occurred_at: new Date(date).toISOString(), date_basis: dateBasis, currency: currency || null, currency_basis: currency ? 'API field' : 'not supplied by source; not inferred', amount: decimal(amount), signed_amount: decimal(sign), direction: sign === null ? 'unknown' : Number(sign) > 0 ? 'credit' : Number(sign) < 0 ? 'debit' : 'zero', amounts: amounts(payload), original_payload: payload, original_line: raw, payload_sha256: digest, response_id: evidence.id, collected_at: evidence.collected_at };
  let inserted = 0;
  if (write) {
    pendingRows.push(row);
  }
  return { eligible: 1, inserted };
}
async function task(accountSummary, label, work) {
  const result = { source: label, eligible: 0, inserted: 0, excluded: 0, requests: 0 };
  accountSummary.sources.push(result);
  try { await work(result); result.status = 'complete'; }
  catch (e) { result.status = 'blocked'; result.error = e.message; }
  try {
    while (pendingRows.length) {
      const batch = pendingRows.slice(0, 100);
      const options = { onConflict: 'account_id,source,semantic,external_id,payload_sha256', ignoreDuplicates: true };
      const inserted = await checked(db.from('financial_statement_entries').upsert(batch, options).select('id'));
      result.inserted += inserted.length;
      if (args.includes('--replay-check')) {
        const replay = await checked(db.from('financial_statement_entries').upsert(batch, options).select('id'));
        if (replay.length) throw new Error('Idempotency violation');
      }
      pendingRows.splice(0, batch.length);
    }
  } catch (e) { result.status = 'blocked'; result.error = e.message; pendingRows = []; }
  console.log(JSON.stringify({ account: accountSummary.account, ...result }));
}
const add = (result, counts) => { for (const key of ['eligible','inserted','excluded']) result[key] += counts[key] || 0; };
const unix = value => new Date(Number(value) * 1000).toISOString();

async function shopee(a, out) {
  const escrow = new Map();
  for (const kind of ['wallet','escrow']) await task(out, `shopee_${kind}`, async result => {
    for (let from = Date.parse(START) / 1000; from < Date.parse(window.end) / 1000; from += 7 * 86400) {
      const to = Math.min(from + 7 * 86400, Math.ceil(Date.parse(window.end) / 1000)) - 1;
      for (let page = 1; ; page++) {
        if (page > 10000) throw new Error('Pagination safety limit');
        const params = { page_size: 100, page_no: page, ...(kind === 'wallet' ? { create_time_from: from, create_time_to: to } : { release_time_from: from, release_time_to: to }) };
        const { json, evidence } = await request(a, `shopee_${kind}`, `/api/v2/payment/get_${kind === 'wallet' ? 'wallet_transaction' : 'escrow'}_list`, params); result.requests++;
        const response = json?.response, rows = response?.[kind === 'wallet' ? 'transaction_list' : 'escrow_list'];
        if (!Array.isArray(rows)) throw new Error('Unrecognized list response');
        for (const row of rows) {
          const date = unix(row[kind === 'wallet' ? 'create_time' : 'escrow_release_time']);
          if (kind === 'escrow' && inPeriod(date, window)) escrow.set(row.order_sn, { date, row });
          const value = kind === 'wallet' ? row.amount : row.payout_amount;
          // Unrecognized money_flow is unknown, never guessed from transaction labels.
          const sign = kind === 'escrow' ? decimal(value) : ['MONEY_IN','MONEY_OUT'].includes(row.money_flow) ? signed(value, row.money_flow) : null;
          add(result, await save(a, `shopee_${kind}`, kind === 'wallet' ? 'wallet_movement' : 'escrow_release', kind === 'wallet' ? row.transaction_id : `${row.order_sn}:${row.escrow_release_time}`, date, kind === 'wallet' ? 'create_time' : 'escrow_release_time', row.currency, value, sign, row, evidence));
        }
        const more = response.more ?? response.has_more ?? response.more_page;
        if (more === false) break;
        if (more !== true) {
          // Undocumented pagination must not be silently interpreted as complete.
          if (rows.length === 100) continue;
          throw new Error(`Pagination flag absent (${Object.keys(response).join(',')}); rows preserved, completeness unverified`);
        }
        if (!rows.length) throw new Error('Empty page with more=true');
      }
    }
  });
  await task(out, 'shopee_escrow_detail', async result => {
    for (const [order, release] of escrow) {
      const { json, evidence } = await request(a, 'shopee_escrow_detail', '/api/v2/payment/get_escrow_detail', { order_sn: order }); result.requests++;
      const income = json.response?.order_income;
      if (!income) throw new Error('Missing order_income');
      add(result, await save(a, 'shopee_escrow_detail', 'order_income_snapshot_at_release', order, release.date, 'escrow_list.escrow_release_time (detail snapshot, not a new movement)', income.currency || json.response.currency, income.escrow_amount_after_adjustment ?? income.escrow_amount, null, json.response, evidence));
    }
  });
}

async function mercadoPago(a, out) {
  await task(out, 'mp_settlement_report', async result => {
    let configuration;
    try { configuration = (await request(a, 'mp_settlement_report', '/v1/account/settlement_report/config')).json; result.requests++; }
    catch (e) {
      if (!e.message.includes('config_not_found_for_user') || !args.includes('--generate-reports')) throw e;
      configuration = (await request(a, 'mp_settlement_report', '/v1/account/settlement_report/config', {}, 'POST', {
        file_name_prefix: 'october-2026-financial-evidence', include_withdraw: true, separator: ',', display_timezone: 'GMT-03', refund_detailed: true, coupon_detailed: true, shipping_detail: true, show_chargeback_cancel: true,
        frequency: { hour: 0, type: 'monthly', value: 1 },
        columns: ['TRANSACTION_DATE','SETTLEMENT_DATE','MONEY_RELEASE_DATE','SOURCE_ID','EXTERNAL_REFERENCE','USER_ID','TRANSACTION_TYPE','TRANSACTION_AMOUNT','TRANSACTION_CURRENCY','SETTLEMENT_NET_AMOUNT','SETTLEMENT_CURRENCY','FEE_AMOUNT','REAL_AMOUNT','TAXES_AMOUNT','METADATA'].map(key => ({ key }))
      })).json; result.requests++;
    }
    result.configuration = { include_withdraw: configuration.include_withdraw, scheduled: configuration.scheduled, columns: configuration.columns };
    let list = (await request(a, 'mp_settlement_report', '/v1/account/settlement_report/list')).json; result.requests++;
    if (!Array.isArray(list)) throw new Error('Unexpected report list');
    // Mercado Pago expands end_date to the end of its report day. Normalize only
    // our requested window; do not generate a second task because of this rounding.
    const matches = item => Date.parse(item.begin_date) === Date.parse(window.start) && Date.parse(item.end_date) >= Date.parse(window.end) - 1000 && Date.parse(item.end_date) < Date.parse('2026-11-01T03:00:00Z');
    if (!list.some(matches) && args.includes('--generate-reports')) {
      const generated = (await request(a, 'mp_settlement_report', '/v1/account/settlement_report', {}, 'POST', { begin_date: window.start, end_date: window.end })).json;
      result.requests++; result.generatedTaskId = generated.id;
      result.generatedPeriod = { begin: generated.begin_date, end: generated.end_date };
      list = (await request(a, 'mp_settlement_report', '/v1/account/settlement_report/list')).json; result.requests++;
    }
    const reports = list.filter(matches); result.reports = reports.map(r => ({ id: r.id, status: r.status, file_name: r.file_name }));
    if (!reports.length) throw new Error('No report for exact requested window; use --write --generate-reports');
    const processed = reports.filter(r => r.status === 'processed' && r.file_name);
    if (!processed.length) throw new Error('Report generation pending; rerun same --end after processing');
    for (const report of processed.slice(-1)) {
      if (!report.file_name.endsWith('.csv')) throw new Error('Only CSV normalization supported; configure a new CSV report through official console');
      const { text, evidence } = await request(a, 'mp_settlement_report', '/v1/account/settlement_report/' + encodeURIComponent(report.file_name)); result.requests++;
      const duplicates = new Map();
      for (const { payload, raw } of reportRows(text, configuration.separator || ',')) {
        const digest = sha(raw), occurrence = (duplicates.get(digest) || 0) + 1; duplicates.set(digest, occurrence);
        const value = payload.REAL_AMOUNT || payload.SETTLEMENT_NET_AMOUNT;
        const date = reportMovementDate(payload);
        add(result, await save(a, 'mp_settlement_report', 'account_transaction', `${payload.SOURCE_ID || digest}:${payload.TRANSACTION_TYPE}:${digest}:${occurrence}`, date, 'SETTLEMENT_DATE (financial event; TRANSACTION_DATE is original purchase)', payload.SETTLEMENT_CURRENCY || payload.TRANSACTION_CURRENCY, value, decimal(value), payload, evidence, raw));
      }
    }
    if (configuration.include_withdraw !== true) throw new Error('Existing report configuration excludes withdrawals; imported returned rows only. Existing configuration was not changed.');
  });
  // Supplemental payment observations are explicitly distinct from account statement.
  await task(out, 'mp_payments', async result => {
    for (let offset = 0; ; offset += 100) {
      const { json, evidence } = await request(a, 'mp_payments', '/v1/payments/search', { range: 'date_created', begin_date: window.start, end_date: window.end, sort: 'date_created', criteria: 'asc', limit: 100, offset }); result.requests++;
      if (!Array.isArray(json.results) || !json.paging) throw new Error('Unexpected payments pagination');
      for (const payment of json.results) {
        const owner = String(a.seller_id || a.account_id);
        const role = String(payment.collector_id ?? payment.collector?.id) === owner ? 'collector' : String(payment.payer?.id ?? payment.payer_id) === owner ? 'payer' : null;
        if (!role) throw new Error('Payment has neither collector nor payer matching account; response retained for review');
        add(result, await save(a, 'mp_payments', role === 'collector' ? 'payment_snapshot' : 'payer_payment_snapshot', payment.id, payment.date_created, 'date_created (not release or cash movement)', payment.currency_id, payment.transaction_amount, null, payment, evidence));
      }
      if (offset + json.results.length >= Number(json.paging.total)) break;
      if (!json.results.length || offset >= 9900) throw new Error('Payment pagination incomplete; partition range before continuing');
    }
  });
}

try {
  for (const account of accounts.filter(a => !selectedAccounts || selectedAccounts.includes(a.name))) {
    const out = { account: account.name, sources: [] }; summary.accounts.push(out);
    if (account.marketplace === 'shopee') await shopee(account, out); else await mercadoPago(account, out);
  }
  summary.status = summary.accounts.some(a => a.sources.some(s => s.status === 'blocked')) ? 'partial' : 'complete';
} catch (e) { summary.status = 'failed'; summary.error = e.message; }
if (write) await checked(db.from('financial_import_runs').update({ finished_at: new Date().toISOString(), status: summary.status, summary }).eq('id', runId));
if (reportPath) writeFileSync(reportPath, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
if (summary.status === 'failed') process.exitCode = 1;
