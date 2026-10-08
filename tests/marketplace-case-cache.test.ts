import test from "node:test";
import assert from "node:assert/strict";
import { CaseReadCache, CASE_CACHE_MS } from "../lib/case-read-cache";
import { detailCacheKey, readCaseCache, updateCaseCache, invalidateCaseCache } from "../app/central-reclamacoes/case-detail-cache";
import { loadPage, memoryDatabase } from "./helpers/page-harness";

test("hard 15-minute expiry, concurrent read dedupe, failure recovery and invalidation race", async () => {
  let now = 1000, reads = 0; const cache = new CaseReadCache<number>(() => now);
  const load = async () => ++reads;
  assert.deepEqual(await Promise.all([cache.get("case", load), cache.get("case", load)]), [1,1]);
  now += CASE_CACHE_MS - 1; assert.equal(await cache.get("case", load), 1);
  now++; assert.equal(await cache.get("case", load), 2);
  cache.invalidate("case"); await assert.rejects(cache.get("case", async () => { throw new Error("offline"); }));
  assert.equal(await cache.get("case", load), 3);
  let resolve!: (v:number) => void;
  cache.invalidate("case"); const stale = cache.get("case", () => new Promise<number>(r => { resolve = r; }));
  await Promise.resolve(); cache.invalidate("case"); cache.put("case", 99); resolve(4); await stale;
  assert.equal(await cache.get("case", load), 99);
  await assert.rejects(cache.get("invalid", async () => null as any));
});

test("browser drilldown only reads one internal endpoint; scopes, accounts, marketplaces and revisions are isolated", async () => {
  let now = 1000, reads = 0;
  const storage: any = { getItem(k:string){return this[k] || null;}, setItem(k:string,v:string){this[k]=v;}, removeItem(k:string){delete this[k];} };
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "sessionStorage", { configurable:true, value:storage });
  const oldNow=Date.now, oldFetch=globalThis.fetch;
  Date.now=()=>now;
  const detail = (id:string) => ({ row:{id}, items:[],messages:[],timeline:[],evidence:[],deadlines:[] });
  globalThis.fetch = async (url:any, options:any) => { reads++; assert.match(String(url), /^\/api\/central-reclamacoes\/case-/); assert.equal(options.method, undefined); return Response.json(detail(String(url).split("/").at(-1)!)); };
  try {
    const row={id:"case-cache",marketplace:"shopee",marketplace_account_id:"SP-ED"};
    const key=detailCacheKey("user-1", "1", row);
    assert.deepEqual((await Promise.all([readCaseCache(key,row.id),readCaseCache(key,row.id)])).map(v=>v.row.id),[row.id,row.id]);
    assert.equal(reads,1); now+=CASE_CACHE_MS-1; await readCaseCache(key,row.id); assert.equal(reads,1);
    now++; await readCaseCache(key,row.id); assert.equal(reads,2);
    for(const account of ["SP-GI","ML-ED","ML-GI"]) await readCaseCache(detailCacheKey("user-1","1",{...row,marketplace_account_id:account,marketplace:account.startsWith("ML")?"mercado_livre":"shopee"}),row.id);
    await readCaseCache(detailCacheKey("user-2","1",row),row.id);
    await readCaseCache(detailCacheKey("user-1","2",row),row.id); assert.equal(reads,7);
    updateCaseCache(key,{...detail(row.id),messages:[{text:"nova mensagem confirmada"}]});
    assert.equal((await readCaseCache(key,row.id)).messages[0].text,"nova mensagem confirmada"); assert.equal(reads,7);
    invalidateCaseCache(key); globalThis.fetch=async()=>Response.json({error:"offline"},{status:503});
    await assert.rejects(readCaseCache(key,row.id));
    globalThis.fetch=async()=>Response.json({row:{id:row.id}}); await assert.rejects(readCaseCache(key,row.id));
    globalThis.fetch=async()=>Response.json(detail(row.id)); assert.equal((await readCaseCache(key,row.id)).row.id,row.id);
  } finally { Date.now=oldNow; globalThis.fetch=oldFetch; if(oldStorage)Object.defineProperty(globalThis,"sessionStorage",oldStorage);else delete (globalThis as any).sessionStorage; }
});

test("server cache retains authorization partitions and makes no writes/external requests", async () => {
  let loads=0, lists=0;
  const db=memoryDatabase({marketplace_cases:[{marketplace:"shopee",marketplace_account_id:"SP-ED"}]});
  const {cachedCaseDetail,cachedCaseList}=loadPage("lib/marketplace-case-read-cache.ts",{
    "server-only":{},"./case-read-cache":{CaseReadCache},"./supabase-admin":{supabaseAdmin:()=>db},"./auth":{},
    "./marketplace-case-detail":{loadCaseDetail:async(id:string)=>{loads++;return {row:{id},messages:[]};}},
    "./marketplace-case-list":{loadCaseList:async()=>{lists++;return {rows:[]};}},
  });
  await Promise.all([cachedCaseDetail("case","user-1","1"),cachedCaseDetail("case","user-1","1")]);assert.equal(loads,1);
  await cachedCaseDetail("case","user-2","1"); await cachedCaseDetail("case","user-1","2");assert.equal(loads,3);
  await cachedCaseList({account:"SP-ED"},"user-1","1");await cachedCaseList({account:"SP-ED"},"user-1","1");assert.equal(lists,1);
  await cachedCaseList({account:"SP-GI"},"user-1","1");assert.equal(lists,2);
  assert.ok(db.calls.every(c=>!["update","insert","upsert","delete","rpc"].includes(c.method)));
});

test("isolated loader read counts: ML 10, Shopee 9; list 10; navigation never writes", async () => {
  const listMocks = { "server-only": {}, "./supabase-admin": {}, "./marketplace-case-context": { caseContext: () => "claim", CLAIM_CONTEXT_FILTER: "claim", RETURN_CONTEXT_FILTER: "return" } };
  const list = loadPage("lib/marketplace-case-list.ts", listMocks);
  for (const marketplace of ["mercado_livre", "shopee"]) {
    const row = { id: "case", marketplace, marketplace_account_id: "account", case_type: marketplace === "shopee" ? "return" : "claim", external_case_id: "123", order_id: "order", snapshot_order_at: "2026-10-01T00:00:00Z", sale: { id: "sale", marketplace, order_id: "order", items: [{ sku: "sku" }] } };
    const db = memoryDatabase({ marketplace_cases: [row], marketplace_conversations: [{ id: "chat", marketplace, marketplace_account_id: "account", order_id: "order", conversation_type: marketplace === "shopee" ? "chat" : "claim", external_conversation_id: "claim:123" }] });
    const { loadCaseDetail } = loadPage("lib/marketplace-case-detail.ts", { "server-only": {}, "./supabase-admin": {}, "./marketplace-case-list": list, "./marketplace-claim-timeline": { orderedClaimTimeline: (v:unknown) => v, saleOfficialEvents: () => [] }, "./shopee-return-milestones": {} });
    await loadCaseDetail("case", db);
    assert.equal(db.calls.filter(c => c.method === "from").length, marketplace === "shopee" ? 9 : 10);
    const listDb = memoryDatabase({ marketplace_cases: [row], config_marketplace_accounts: [{ id: "account" }] }, 100);
    await list.loadCaseList({}, listDb);
    assert.equal(listDb.calls.filter(c => c.method === "from").length, 10);
  }
});
