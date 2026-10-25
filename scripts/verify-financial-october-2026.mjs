import nextEnv from '@next/env';
import { createClient } from '@supabase/supabase-js';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { sha, parseLossless, reportRows } from './financial-import-core.mjs';
nextEnv.loadEnvConfig(process.cwd(), false, { info() {}, error() {} });
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
if (new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname !== 'ukfefrdaivqzxeeknmqr.supabase.co') throw new Error('Unexpected project');
async function read(table) {
 const all=[];
 for(let offset=0;;offset+=1000) {
  const {data,error}=await db.from(table).select('*').order('id').range(offset,offset+999);
  if(error) throw new Error(error.code);
  all.push(...data); if(data.length<1000) return all;
 }
}
const [entries,responses,runs]=await Promise.all(['financial_statement_entries','financial_api_responses','financial_import_runs'].map(read));
const canonical = value => JSON.stringify(sort(value));
function sort(value) { if(Array.isArray(value))return value.map(sort); if(value && typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,sort(value[k])]));return value; }
const responseMap=new Map();
for(const response of responses) {
 const bytes=Buffer.from(response.body_base64,'base64'); assert.equal(sha(bytes),response.body_sha256);
 let payload;try{payload=parseLossless(bytes.toString('utf8'));}catch{payload=null;}
 responseMap.set(response.id,{...response,payload,text:bytes.toString('utf8')});
}
let exactPayloads=0, exactLines=0, longIds=0;
const identities=new Set();
const groups=new Map();
const cents=value=>{const text=String(value),negative=text.startsWith('-'),[whole,fraction='']=text.replace(/^-/,'').split('.');assert.ok(/^\d+$/.test(whole) && /^\d*$/.test(fraction) && !/[1-9]/.test(fraction.slice(2)));return (BigInt(whole)*100n+BigInt((fraction+'00').slice(0,2)))*(negative?-1n:1n);};
const money=value=>`${value<0n?'-':''}${(value<0n?-value:value)/100n}.${String((value<0n?-value:value)%100n).padStart(2,'0')}`;
for(const entry of entries) {
 const response=responseMap.get(entry.response_id);assert.ok(response);
 assert.equal(response.account_id,entry.account_id);assert.equal(response.source,entry.source);
 const run=runs.find(r=>r.id===response.run_id);assert.ok(run);
 assert.ok(Date.parse(entry.occurred_at)>=Date.parse(run.period_start) && Date.parse(entry.occurred_at)<Date.parse(run.period_end));
 const key=[entry.account_id,entry.source,entry.semantic,entry.external_id,entry.payload_sha256].join('|'); assert.ok(!identities.has(key));identities.add(key);
 let candidates;
 if(entry.source==='shopee_wallet') candidates=response.payload.response.transaction_list;
 else if(entry.source==='shopee_escrow') candidates=response.payload.response.escrow_list;
 else if(entry.source==='shopee_escrow_detail') candidates=[response.payload.response];
 else if(entry.source==='mp_payments') candidates=response.payload.results;
 else if(entry.source==='mp_settlement_report') {
  const rows=reportRows(response.text, response.text.split(/\r?\n/,1)[0].includes(';')?';':',');
  candidates=rows.map(r=>r.payload);
  assert.ok(rows.some(r=>r.raw===entry.original_line));exactLines++;
 } else throw new Error('Unknown source');
 assert.ok(candidates.some(value=>canonical(value)===canonical(entry.original_payload)),`Payload mismatch ${entry.id}`);exactPayloads++;
 if(entry.source==='shopee_wallet' && entry.external_id.length>15) { assert.equal(typeof entry.original_payload.transaction_id,'string');assert.equal(entry.external_id,entry.original_payload.transaction_id);longIds++; }
 const groupKey=[entry.account_name,entry.source,entry.semantic,entry.currency||'not supplied'].join('|');
 if(!groups.has(groupKey))groups.set(groupKey,{account:entry.account_name,source:entry.source,semantic:entry.semantic,currency:entry.currency,records:0,amountCents:0n,signedCents:0n,knownSigns:0,firstAt:entry.occurred_at,lastAt:entry.occurred_at});
 const group=groups.get(groupKey);group.records++;
 const p=entry.original_payload;
 const originalAmount=entry.source==='shopee_wallet'?p.amount:entry.source==='shopee_escrow'?p.payout_amount:entry.source==='shopee_escrow_detail'?(p.order_income.escrow_amount_after_adjustment??p.order_income.escrow_amount):entry.source==='mp_payments'?p.transaction_amount:(p.REAL_AMOUNT||p.SETTLEMENT_NET_AMOUNT);
 if(originalAmount!=null)group.amountCents+=cents(originalAmount);
 if(entry.signed_amount!=null){group.signedCents+=cents(entry.signed_amount);group.knownSigns++;}
 if(Date.parse(entry.occurred_at)<Date.parse(group.firstAt))group.firstAt=entry.occurred_at;
 if(Date.parse(entry.occurred_at)>Date.parse(group.lastAt))group.lastAt=entry.occurred_at;
}
const anonymous=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL,process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,{auth:{persistSession:false}});
const access=[];
for(const table of ['financial_import_runs','financial_api_responses','financial_statement_entries']) {
 const readResult=await anonymous.from(table).select('id').limit(1);assert.ok(readResult.error,'Anonymous SELECT unexpectedly authorized');
 const writeResult=await anonymous.from(table).insert({id:'00000000-0000-0000-0000-000000000000'});assert.ok(writeResult.error,'Anonymous INSERT unexpectedly authorized');
 access.push({table,readDenied:readResult.error.code,writeDenied:writeResult.error.code});
}
const totals=[...groups.values()].map(({amountCents,signedCents,knownSigns,...group})=>({...group,sourceAmountTotal:money(amountCents),signedTotal:knownSigns?money(signedCents):null,knownSigns})).sort((a,b)=>(a.account+a.source+a.semantic).localeCompare(b.account+b.source+b.semantic));
const result={verifiedAt:new Date().toISOString(),entries:entries.length,responses:responses.length,runs:runs.map(({id,status,period_start,period_end})=>({id,status,period_start,period_end})),verifiedBodyHashes:responses.length,exactPayloads,exactLines,longIds,duplicateIdentityCount:entries.length-identities.size,anonymousAccess:access,totals};
const path=process.argv.find(a=>a.startsWith('--report='))?.slice(9);if(path)writeFileSync(path,JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
