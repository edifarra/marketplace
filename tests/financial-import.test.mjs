import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLossless, csvRecords, reportRows, reportMovementDate, inPeriod, START, signed, decimal, amounts, sha } from '../scripts/financial-import-core.mjs';

test('financial IDs and decimal lexemes survive without IEEE754 rounding', () => {
 const raw='{"transaction_id":252347025113224544,"amount":267.0400,"missing":null,"flag":true}';
 const parsed=parseLossless(raw);
 assert.equal(parsed.transaction_id,'252347025113224544');
 assert.equal(parsed.amount,'267.0400');
 assert.equal(parsed.flag,true);
 assert.equal(decimal(parsed.flag),null);
 assert.deepEqual(amounts(parsed),{amount:'267.0400'});
 assert.equal(sha(Buffer.from(raw)),sha(raw));
});
test('São Paulo October boundary differs from UTC and source timezone',()=>{
 const window={start:START,end:'2026-10-25T20:30:00Z'};
 assert.equal(inPeriod('2026-09-30T23:09:35-04:00',window),true);
 assert.equal(inPeriod('2026-10-01T02:59:59Z',window),false);
 assert.equal(inPeriod(window.end,window),false);
 assert.equal(inPeriod('2026-11-01T00:00:00-03:00',window),false);
});
test('October dispute of September purchase belongs to October financial statement',()=>{
 const payload={TRANSACTION_DATE:'2026-09-30T15:37:07-04:00',SETTLEMENT_DATE:'2026-10-08T16:48:33-04:00'};
 assert.equal(inPeriod(reportMovementDate(payload),{start:START,end:'2026-10-25T20:30:00Z'}),true);
 assert.throws(()=>reportMovementDate({SETTLEMENT_DATE:'2026-10-08T10:00:00'}),/unzoned/);
});
test('wallet signs follow explicit flow, negative escrow remains negative',()=>{
 assert.equal(signed('12.50','MONEY_OUT'),'-12.50');
 assert.equal(signed('-12.50','MONEY_OUT'),'-12.50');
 assert.equal(signed('-28.25'),'-28.25');
 assert.equal(decimal(null),null);
});
test('CSV quoted multiline payload, blanks, CRLF and duplicate record texts are retained',()=>{
 const text='TRANSACTION_DATE,SOURCE_ID,METADATA,REAL_AMOUNT\r\n2026-10-01T00:00:00-03:00,123,"one, two\r\n""quoted""",-1.20\r\n';
 const rows=reportRows(text,',');
 assert.equal(rows.length,1);
 assert.equal(rows[0].payload.METADATA,'one, two\r\n"quoted"');
 assert.equal(rows[0].payload.REAL_AMOUNT,'-1.20');
 assert.ok(rows[0].raw.includes('\r\n'));
 assert.throws(()=>csvRecords('a,"b'),/Unterminated/);
 assert.throws(()=>reportRows('TRANSACTION_DATE,SOURCE_ID\n1,2,3',','),/width/);
});
