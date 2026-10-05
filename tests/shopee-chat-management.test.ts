import assert from "node:assert/strict";
import test from "node:test";
import "../scripts/register-server-only.cjs";
import { ShopeeClient, shopeeConversationActionBody } from "../lib/marketplaces/shopee/client";
import { latestShopeeMessageId, validShopeeMessageId, reconcileShopeeChatManagement, assertShopeeChatReceipt } from "../lib/shopee-chat-management-state";
import { executeShopeeConversationAction } from "../lib/shopee-chat-management";
import { processOutgoingActivities } from "../lib/outgoing-activities";
import { mergeConversationDelta } from "../lib/marketplace-conversation-delta";
import { ConversationView } from "../lib/marketplace-conversation-view";

const conversationId = "4708284056837296129", messageId = "2439066547202146673";
const receipt = { error: "", request_id: "test-receipt", response: {} };
const view: ConversationView = { tab: "all", marketplace: "", store: "", status: "", sla: "", search: "", from: "", to: "", unread: "" };

test("Shopee POST preserva conversation_id int64 numérico e last_read_message_id textual", async () => {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const original = global.fetch;
  global.fetch = async (input, init) => { calls.push({ url: new URL(String(input)), init }); return Response.json(receipt); };
  try {
    const client = new ShopeeClient({ partnerId: "123", partnerKey: "test-only", redirectUri: "https://example.test/callback" });
    await client.deleteConversation("test-token", "456", conversationId);
    await client.readConversation("test-token", "456", conversationId, messageId);
    assert.equal(calls[0].url.pathname, "/api/v2/sellerchat/delete_conversation");
    assert.equal(calls[1].url.pathname, "/api/v2/sellerchat/read_conversation");
    assert.equal(calls[0].init?.body, '{"conversation_id":4708284056837296129}');
    assert.equal(calls[1].init?.body, '{"conversation_id":4708284056837296129,"last_read_message_id":"2439066547202146673"}');
    for (const call of calls) { assert.equal(call.init?.method, "POST"); assert.equal(call.url.searchParams.get("shop_id"), "456"); assert.ok(call.url.searchParams.get("sign")); }
    assert.throws(() => shopeeConversationActionBody('1,"shop_id":7'));
    assert.throws(() => shopeeConversationActionBody("9223372036854775808"));
    assert.throws(() => shopeeConversationActionBody(conversationId, "draft:123"));
  } finally { global.fetch = original; }
});

test("seleção de IDs ignora drafts e números com precisão perdida", () => {
  assert.equal(validShopeeMessageId(Number(messageId)), "");
  assert.equal(latestShopeeMessageId([{external_message_id:"draft:999"},{message_id:"2439066547202146672"},{message_id:messageId}]), messageId);
  for (const payload of [{}, {request_id:"test"}, {...receipt,error:"permission_denied"}]) assert.throws(() => assertShopeeChatReceipt(payload));
  assert.doesNotThrow(() => assertShopeeChatReceipt(receipt));
});

test("leitura preserva obrigação de resposta e mensagem nova volta a ficar não lida", () => {
  const base = { shopee_last_message_id: "100", shopee_last_incoming_message_id: "100", shopee_read_message_id: "100", requires_response: true };
  assert.equal(reconcileShopeeChatManagement({...base,unread:true},base).unread, false);
  assert.equal(reconcileShopeeChatManagement({...base,unread:true},base).requires_response, true);
  assert.equal(reconcileShopeeChatManagement({...base,shopee_last_message_id:"101",shopee_last_incoming_message_id:"101",unread:true},base).unread,true);
  assert.equal(reconcileShopeeChatManagement({...base,shopee_last_message_id:"101",unread:true},base).unread,true);
  assert.equal(reconcileShopeeChatManagement({...base,shopee_last_message_id:"90"},base).shopee_last_message_id,"100");
});

test("exclusão confirmada sai do delta e nova mensagem pode reabrir o chat", () => {
  const row:any = { id:"c1",groupKey:"single:c1",grouped_conversation_ids:["c1"],requires_response:true,last_message_at:"2026-10-05T12:00:00Z",messages:[],shopee_deleted_at:"2026-10-05T12:01:00Z",shopee_deleted_message_id:"100",shopee_last_message_id:"100" };
  assert.deepEqual(mergeConversationDelta([{...row,shopee_deleted_at:null}], [row], [row.id], view,25), []);
  assert.ok(!("shopee_deleted_at" in reconcileShopeeChatManagement({shopee_last_message_id:"100"},row)));
  const reopened = reconcileShopeeChatManagement({...row,shopee_last_message_id:"101"},row);
  assert.equal(reopened.shopee_deleted_at,null);
  assert.equal(mergeConversationDelta([], [reopened as any], [row.id],view,25).length,1);
});

// Exercise the actual worker executor with offline HTTP responses. No credentials
// or live marketplace/database are used by these tests.
async function workerScenario(action: string, options: {permissionError?:boolean; newer?:boolean; finalizeError?:boolean; savedReceipt?:boolean; wrongAccount?:boolean; throughQueue?:boolean} = {}) {
  const originalFetch=global.fetch;
  const oldUrl=process.env.NEXT_PUBLIC_SUPABASE_URL, oldKey=process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.NEXT_PUBLIC_SUPABASE_URL="https://offline-database.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY="offline-test-key";
  const calls:string[]=[]; const writes:Array<{path:string;body:any}>=[];
  const activity={id:"a1",source_id:"c1",destination:"shopee",activity_type:action,marketplace_account_id:"account1",attempt_count:1,requested_data:{conversationId:"c1",externalConversationId:conversationId,lastMessageId:messageId}};
  const account={id:"account1",name:"Test",marketplace:"shopee",active:true,shop_id:"456",access_token:"test-token",token_expires_at:"2099-01-01",client_id:"123",client_secret:"test-only",redirect_uri:"https://example.test/callback",api_base_url:"https://offline-shopee.test"};
  global.fetch=async(input,init)=>{
    const url=new URL(String(input)); const path=url.pathname; calls.push(`${init?.method || "GET"} ${path}`);
    if(init?.body) writes.push({path,body:JSON.parse(String(init.body))});
    if(path.endsWith("claim_outgoing_marketplace_activity_queue")) return Response.json([activity]);
    if(path.endsWith("outgoing_marketplace_activity_history")) return new Response(null,{status:201});
    if(path.endsWith("marketplace_conversations")) return Response.json({id:"c1",marketplace:"shopee",marketplace_account_id:options.wrongAccount?"other":account.id,external_conversation_id:conversationId});
    if(path.endsWith("outgoing_marketplace_activities")) {
      if(init?.method==="PATCH") return new Response(null,{status:204});
      return Response.json({confirmed_data:options.savedReceipt?{shopeeChatReceipt:receipt}:null});
    }
    if(path.endsWith("config_marketplace_accounts")) return Response.json(url.searchParams.has("id")?account:[account]);
    if(path.endsWith("get_one_conversation")) return Response.json({response:{latest_message_id:options.newer?"2439066547202146674":messageId}});
    if(path.endsWith("read_conversation")||path.endsWith("delete_conversation")) return Response.json(options.permissionError?{error:"permission_denied",request_id:"denied"}:receipt);
    if(path.endsWith("finalize_shopee_conversation_action")) return options.finalizeError?Response.json({message:"local persistence failed",code:"TEST"},{status:500}):Response.json(null);
    throw new Error(`Unexpected offline request: ${path}`);
  };
  let error:unknown, result:unknown;
  try {result=options.throughQueue?await processOutgoingActivities(1):await executeShopeeConversationAction(activity);} catch(e){error=e;}
  finally {global.fetch=originalFetch; if(oldUrl===undefined)delete process.env.NEXT_PUBLIC_SUPABASE_URL;else process.env.NEXT_PUBLIC_SUPABASE_URL=oldUrl; if(oldKey===undefined)delete process.env.SUPABASE_SERVICE_ROLE_KEY;else process.env.SUPABASE_SERVICE_ROLE_KEY=oldKey;}
  return {calls,error,result,writes};
}

test("worker marca lido na Shopee e só finaliza localmente depois do recibo persistido", async () => {
  const {calls,error,result}=await workerScenario("conversation_read");
  assert.ifError(error); assert.ok(result);
  const post=calls.indexOf("POST /api/v2/sellerchat/read_conversation"), save=calls.indexOf("PATCH /rest/v1/outgoing_marketplace_activities"), finalize=calls.indexOf("POST /rest/v1/rpc/finalize_shopee_conversation_action");
  assert.ok(post>=0&&save>post&&finalize>save);
});
test("worker exclui via API e bloqueia exclusão quando chegou mensagem nova", async () => {
  const ok=await workerScenario("conversation_delete");assert.ifError(ok.error);assert.ok(ok.calls.includes("POST /api/v2/sellerchat/delete_conversation"));
  const changed=await workerScenario("conversation_delete",{newer:true});assert.ok(changed.error);assert.ok(!changed.calls.includes("POST /api/v2/sellerchat/delete_conversation"));
});
test("permissão recusada não confirma a ação nem altera estado local", async () => {
  const {calls,error}=await workerScenario("conversation_read",{permissionError:true}); assert.ok(error);
  assert.ok(!calls.includes("PATCH /rest/v1/outgoing_marketplace_activities")); assert.ok(!calls.includes("POST /rest/v1/rpc/finalize_shopee_conversation_action"));
});
test("falha local após recibo permite retry sem repetir POST na Shopee", async () => {
  const failed=await workerScenario("conversation_delete",{finalizeError:true}); assert.ok(failed.error);assert.ok(failed.calls.includes("PATCH /rest/v1/outgoing_marketplace_activities"));
  const retry=await workerScenario("conversation_delete",{savedReceipt:true});assert.ifError(retry.error);assert.ok(retry.calls.includes("POST /rest/v1/rpc/finalize_shopee_conversation_action"));assert.ok(!retry.calls.some(call=>call.includes("sellerchat")));
});
test("worker rejeita divergência entre conta enfileirada e conversa", async () => {
  const {calls,error}=await workerScenario("conversation_read",{wrongAccount:true});assert.ok(error);assert.ok(!calls.some(call=>call.includes("sellerchat")));
});

test("dispatcher da fila conclui ação Shopee e mantém o histórico auditado", async () => {
  const run=await workerScenario("conversation_read",{throughQueue:true}); assert.ifError(run.error);
  assert.equal((run.result as any).completed,1);
  assert.ok(run.writes.some(write=>write.path.endsWith("outgoing_marketplace_activities")&&write.body.status==="completed"));
  assert.ok(run.writes.some(write=>write.path.endsWith("outgoing_marketplace_activity_history")&&write.body.status==="completed"));
});
test("exclusão com mensagem nova fica em erro na fila sem mudar a conversa", async () => {
  const run=await workerScenario("conversation_delete",{throughQueue:true,newer:true});assert.ifError(run.error);
  assert.equal((run.result as any).failed,1);
  assert.ok(run.writes.some(write=>write.path.endsWith("outgoing_marketplace_activities")&&write.body.status==="error"));
  assert.ok(!run.writes.some(write=>write.path.endsWith("marketplace_conversations")));
});
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConversationGrid } from "../app/chats-perguntas/conversation-grid";
Object.assign(globalThis, { React });
test("menu Shopee exibe Excluir chat e Marcar como lido sem simular silenciamento", () => {
  const row:any={id:"c1",marketplace:"shopee",external_conversation_id:conversationId,conversation_type:"chat",requires_response:false,unread:true,status:"answered",messages:[],buyer_name:"Cliente teste",last_message_at:"2026-10-05T12:00:00Z",shopee_last_message_id:messageId};
  const props={rows:[row],initialCursor:{id:"c1",updatedAt:"2026-10-05T12:00:00Z"},view,pageSize:25};
  const renderGrid = (value: typeof props) => renderToStaticMarkup(React.createElement(AppRouterContext.Provider, { value: { refresh() {}, push() {}, replace() {}, back() {}, forward() {}, prefetch: async () => {} } }, React.createElement(ConversationGrid,value)));
  const html=renderGrid(props);
  assert.ok(html.includes("Excluir chat"));assert.ok(html.includes("Marcar como lido"));assert.ok(html.includes("não dispensa responder"));assert.ok(!html.includes("Silenciar"));
  const ml=renderGrid({...props,rows:[{...row,marketplace:"mercado_livre"}]});assert.ok(!ml.includes("Excluir chat"));
});
