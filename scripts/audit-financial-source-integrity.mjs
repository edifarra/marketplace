// Read-only verifier. Production responses live only in memory, never fixtures.
import nextEnv from '@next/env';
import {createClient} from '@supabase/supabase-js';
import assert from 'node:assert/strict';
import {writeFileSync,readFileSync} from 'node:fs';
import {sha,reportRows,csvRecords,statementEventKey} from './financial-import-core.mjs';
nextEnv.loadEnvConfig(process.cwd(),false,{info(){},error(){}});
const db=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
if(new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname!=='ukfefrdaivqzxeeknmqr.supabase.co')throw new Error('Unexpected project');
async function read(table,columns,source){const all=[];for(let n=0;;n+=1000){let q=db.from(table).select(columns).order('id').range(n,n+999);if(source)q=q.eq('source',source);const {data,error}=await q;if(error)throw new Error('Read failed');all.push(...data);if(data.length<1000)return all;}}
const [entries,responses]=await Promise.all([
 read('financial_statement_entries','id,account_id,account_name,source,semantic,external_id,original_payload,original_line,signed_amount,occurred_at,response_id','mp_settlement_report'),
 read('financial_api_responses','id,body_base64,body_sha256,endpoint','mp_settlement_report')]);
const parsed=new Map(),hashes=new Set();let checkedHashes=0,financialChecks=0,textDifferences=0,jsonFields=0;
for(const r of responses){if(!r.endpoint.endsWith('.csv'))continue;const bytes=Buffer.from(r.body_base64,'base64');assert.equal(sha(bytes),r.body_sha256);checkedHashes++;hashes.add(r.body_sha256);const text=bytes.toString('utf8');parsed.set(r.id,reportRows(text,text.split(/\r?\n/)[0].includes(';')?';':','));}
const accounts={},textFields=new Set();
for(const e of entries){const p=parsed.get(e.response_id)?.find(r=>r.raw===e.original_line)?.payload;assert.ok(p,'Original row missing');
 for(const key of Object.keys(e.original_payload)){if(p[key]===e.original_payload[key])continue;assert.ok(['METADATA','OPERATION_TAGS'].includes(key),'Unexpected non-textual difference');textFields.add(key);}
 for(const key of ['SOURCE_ID','TRANSACTION_TYPE','TRANSACTION_AMOUNT','FEE_AMOUNT','REAL_AMOUNT','SETTLEMENT_NET_AMOUNT','TRANSACTION_DATE','SETTLEMENT_DATE','MONEY_RELEASE_DATE'])assert.equal(p[key],e.original_payload[key]);
 assert.equal(Number(p.REAL_AMOUNT || p.SETTLEMENT_NET_AMOUNT),Number(e.signed_amount));assert.equal(Date.parse(p.SETTLEMENT_DATE),Date.parse(e.occurred_at));financialChecks++;
 if(JSON.stringify(p)!==JSON.stringify(e.original_payload)){
  if(Object.keys(p).some(k=>p[k]!==e.original_payload[k]))textDifferences++;
 }
 for(const key of ['METADATA','OPERATION_TAGS'])if(p[key]?.startsWith('[') || p[key]?.startsWith('{')){JSON.parse(p[key]);jsonFields++;}
 accounts[e.account_name]=(accounts[e.account_name]||0)+1;
}
assert.equal(entries.length,239);assert.equal(accounts['ML-ED'],98);assert.equal(accounts['ML-GI'],141);assert.equal(textDifferences,70);
const result={verified_at:new Date().toISOString(),read_only:true,production_writes:0,reference_rows:entries.length,accounts,checked_response_hashes:checkedHashes,distinct_files:hashes.size,financial_rows_unchanged:financialChecks,textual_legacy_differences:textDifferences,affected_text_fields:[...textFields],valid_json_fields:jsonFields,fixtures:'fully synthetic; production bytes not written to disk'};
const baseline=process.argv.find(x=>x.startsWith('--baseline='))?.slice(11);
if(baseline){
 const [head,...records]=csvRecords(readFileSync(baseline,'utf8'),',').map(r=>r.fields);
 const baselineRows=records.map(r=>Object.fromEntries(head.map((k,i)=>[k,r[i]]))).filter(r=>Number(r.diferenca)!==0);
 assert.equal(baselineRows.length,67);
 const snapshots=await read('financial_statement_entries','id,external_id,original_payload','mp_payments');
 const indexed=new Map(snapshots.map(s=>[s.external_id,s.original_payload]));
 result.prior_67_review=baselineRows.map(r=>{const pp=(r.pagamentos||'').split('|').map(id=>indexed.get(id)).filter(Boolean);return {account:r.conta,order_id:r.pedido,payment_ids:r.pagamentos,snapshots:pp.length,statuses:[...new Set(pp.map(p=>p.status))],has_shipping_charge:pp.some(p=>(p.charges_details||[]).some(c=>c.name==='shp_cross_docking')),has_refund:pp.some(p=>Number(p.transaction_amount_refunded)>0),has_incoming_charge:pp.some(p=>(p.charges_details||[]).some(c=>c.accounts?.to==='collector')),diagnosis:'Original vs current snapshot must retain payment state; no universal 67-row correction or historical write.'};});
}
const report=process.argv.find(x=>x.startsWith('--report='))?.slice(9);if(report)writeFileSync(report,JSON.stringify(result,null,2));
console.log(JSON.stringify({...result,prior_67_review:result.prior_67_review ? {reviewed:result.prior_67_review.length,shipping:result.prior_67_review.filter(r=>r.has_shipping_charge).length,refunds:result.prior_67_review.filter(r=>r.has_refund).length,incoming:result.prior_67_review.filter(r=>r.has_incoming_charge).length}:undefined}));
