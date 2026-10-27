import test from 'node:test';
import assert from 'node:assert/strict';
import {csvRecords,reportRows,statementEventKey,latestProcessedReport,selectStatementSnapshot,planStatementImport} from '../scripts/financial-import-core.mjs';

test('MP raw JSON and RFC escaped JSON preserve inner quotes, delimiters and newlines',()=>{
 for(const field of ['"[{"device_id":"synthetic;value","n":1}]"','"[{""device_id"":""synthetic;value"",""n"":1}]"','[{"device_id":"synthetic;value","n":1}]']) {
  const text='TRANSACTION_DATE;METADATA;REAL_AMOUNT\n2026-01-01T00:00:00Z;'+field+';-1.23\n';
  const p=reportRows(text,';')[0].payload;
  assert.deepEqual(JSON.parse(p.METADATA),[{device_id:'synthetic;value',n:1}]); assert.equal(p.REAL_AMOUNT,'-1.23');
 }
 assert.throws(()=>csvRecords('a;"[{"broken":]"',';'),/invalid|Unterminated/);
 assert.throws(()=>reportRows('TRANSACTION_DATE;SOURCE_ID;SOURCE_ID\nx;1;2',';'),/Duplicate/);
});
test('fully synthetic 98 ED and 141 GI rows retain multiplicity, 70 quoted JSON fields and cents',()=>{
 let total=0;
 for(const [count,sep] of [[98,','],[141,';']]){
  const header=['TRANSACTION_DATE','SETTLEMENT_DATE','SOURCE_ID','TRANSACTION_TYPE','REAL_AMOUNT','METADATA'];
  const records=Array.from({length:count},(_,i)=>['2026-01-01T00:00:00Z','2026-01-01T00:00:01Z',String(900000000000+i),'SETTLEMENT',i%2?'1.23':'-2.34',i<70 && count===141?'"[{"fixture":"value","n":1}]"':''].join(sep));
  const rows=reportRows([header.join(sep),...records].join('\r\n'),sep);assert.equal(rows.length,count);total+=rows.length;
  assert.equal(new Set(rows.map(r=>statementEventKey(r.payload))).size,count);
  assert.equal(rows.filter(r=>r.payload.METADATA).length,count===141?70:0);
  assert.deepEqual(rows.map(r=>r.payload.REAL_AMOUNT),records.map(r=>r.split(sep)[4]));
 }
 assert.equal(total,239);
});
test('latest processed provider version is independent of API list order',()=>{
 const old={id:'9',date_created:'2026-01-01',status:'processed',file_name:'old.csv'},current={...old,id:'10',date_created:'2026-01-02',file_name:'new.csv'};
 for(const list of [[current,old],[old,current]])assert.equal(latestProcessedReport(list)?.id,'10');
 assert.equal(latestProcessedReport([{...current,status:'pending'},old])?.id,'9');
});
test('event identity survives regenerated quoting/amount changes; snapshots never add revisions twice',()=>{
 const p={SOURCE_ID:'123456789012345678',TRANSACTION_TYPE:'DISPUTE',SETTLEMENT_DATE:'2026-01-01T00:00:00Z'};
 assert.equal(statementEventKey({...p,REAL_AMOUNT:'1'}),statementEventKey({...p,REAL_AMOUNT:'2'}));
 assert.notEqual(statementEventKey(p,1),statementEventKey(p,2));
 const old={id:'old',account_id:'a',source:'mp_settlement_report',external_id:statementEventKey(p),payload_sha256:'old',response_id:'old'},updated={...old,id:'new',response_id:'new',payload_sha256:'new'};
 assert.deepEqual(selectStatementSnapshot([old,updated,updated],['new','new']),[updated]);
 assert.throws(()=>selectStatementSnapshot([old]),/membership/);
});
test('actual import plan reuses historical rows unchanged and regenerated equivalent records; one revision per snapshot',()=>{
 const header='TRANSACTION_DATE;SETTLEMENT_DATE;SOURCE_ID;TRANSACTION_TYPE;REAL_AMOUNT;METADATA\n';
 const raw='2026-01-01T00:00:00Z;2026-01-01T00:00:01Z;123;SETTLEMENT;1.00;"[{"fixture":"value"}]"';
 const rows=reportRows(header+raw,';'),window={start:'2026-01-01T00:00:00Z',end:'2026-02-01T00:00:00Z'};
 const before=[{id:'historical',original_line:raw,original_payload:{...rows[0].payload,METADATA:'[{fixture:value}]'}}];
 const frozen=JSON.stringify(before);assert.equal(planStatementImport(rows,before,window)[0].reuseId,'historical');assert.equal(JSON.stringify(before),frozen);
 const prior=[{id:'new',original_line:raw,original_payload:rows[0].payload}];
 const regenerated=reportRows(header+raw.replace('"[{"fixture":"value"}]"','"[{""fixture"":""value""}]"'),';');
 assert.equal(planStatementImport(regenerated,prior,window)[0].reuseId,'new');
 const changed=reportRows(header+raw.replace(';1.00;',';2.00;'),';');
 assert.equal(planStatementImport(changed,prior,window)[0].reuseId,null);
 const duplicates=planStatementImport([rows[0],rows[0]],prior,window);assert.equal(duplicates.filter(r=>r.reuseId).length,1);assert.notEqual(duplicates[0].externalId,duplicates[1].externalId);
});
