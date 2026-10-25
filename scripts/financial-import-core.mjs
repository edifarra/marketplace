import { createHash } from 'node:crypto';
export const START = '2026-10-01T03:00:00.000Z';
export const MAX_END = '2026-10-26T03:00:00.000Z';
export const sha = value => createHash('sha256').update(value).digest('hex');
// Numeric lexemes remain strings: no rounding of 18-digit Shopee IDs or decimals.
// The response bytes, including original JSON number types, are stored separately.
export function parseLossless(text) {
  return JSON.parse(text, (_key, value, context) => typeof value === 'number' ? context.source : value);
}
export function period(end) {
  const parsed = new Date(end);
  if (!Number.isFinite(+parsed) || +parsed <= Date.parse(START) || +parsed > Date.parse(MAX_END) || +parsed > Date.now()) throw new Error('End must be in October 1..25, 2026, and not in the future.');
  return { start: START, end: parsed.toISOString() };
}
export function inPeriod(date, window) {
  return Number.isFinite(Date.parse(date)) && Date.parse(date) >= Date.parse(window.start) && Date.parse(date) < Date.parse(window.end);
}
export const decimal = value => typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value) ? value : null;
export function signed(value, flow) {
  const amount = decimal(value);
  if (amount === null) return null;
  if (flow === 'MONEY_OUT') return '-' + amount.replace(/^-/, '');
  if (flow === 'MONEY_IN') return amount.replace(/^-/, '');
  return amount;
}
export function amounts(value, prefix = '', result = {}) {
  if (!value || typeof value !== 'object') return result;
  for (const [key, item] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (item && typeof item === 'object') amounts(item, path, result);
    else if (/amount|fee|rebate|balance|income|price|refund|commission|payout|escrow|tax/i.test(key) && decimal(item) !== null) result[path] = item;
  }
  return result;
}
// RFC4180, with exact record text retained (embedded CR/LF and quoted separators).
export function csvRecords(text, separator = ',') {
  const records = []; let fields = [], field = '', quoted = false, start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (c === separator && !quoted) { fields.push(field); field = ''; }
    else if ((c === '\n' || c === '\r') && !quoted) {
      fields.push(field); records.push({ fields, raw: text.slice(start, i) }); fields = []; field = '';
      if (c === '\r' && text[i + 1] === '\n') i++;
      start = i + 1;
    } else field += c;
  }
  if (quoted) throw new Error('Unterminated CSV quote');
  if (start < text.length) { fields.push(field); records.push({ fields, raw: text.slice(start) }); }
  return records.filter(r => r.raw.trim());
}
export function reportRows(text, separator) {
  const [header, ...records] = csvRecords(text.replace(/^\uFEFF/, ''), separator);
  if (!header || !header.fields.includes('TRANSACTION_DATE')) throw new Error('Unrecognized report header; bytes retained, no guessed mapping.');
  return records.map(record => {
    if (record.fields.length !== header.fields.length) throw new Error('CSV width mismatch');
    return { payload: Object.fromEntries(header.fields.map((h, i) => [h, record.fields[i]])), raw: record.raw };
  });
}
export function reportMovementDate(payload) {
  // Account-money reports contain the original payment creation date as well as
  // the financial event date. Refunds/disputes can refer to older purchases.
  const date = payload.SETTLEMENT_DATE;
  if (!date || !/(Z|[+-]\d{2}:?\d{2})$/.test(date) || !Number.isFinite(Date.parse(date))) throw new Error('Missing/unzoned SETTLEMENT_DATE; original bytes retained');
  return date;
}
