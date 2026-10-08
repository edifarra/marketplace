import "server-only";
import { createHash,createHmac,timingSafeEqual } from "node:crypto";
import { supabaseAdmin } from "./supabase-admin";
import { getMercadoLivreAccountById,getMercadoLivreResource,getValidMercadoLivreAccessToken } from "./mercado-livre";
import { loadMercadoLivreClaimBundle } from "./marketplace-case-enrichment";
import { normalizeCase } from "./marketplace-case-domain";
import { persistCaseObservation } from "./marketplace-cases";
import { ClaimAction,ClaimError,ClaimRow,claimBuyerId,validPartialOffers,validateClaimAction,validatePartialOffer,claimPayload } from "./marketplace-claim-domain";
import { ClaimOperation,ClaimRemoteError,executeClaimOperation } from "./marketplace-claim-operations";

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const canonical=(v:any):string => JSON.stringify(v && typeof v === "object" ? Array.isArray(v) ? v.map(x=>JSON.parse(canonical(x))) : Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(canonical(v[k]))])) : v ?? null);
const digest=(v:any)=>createHash("sha256").update(canonical(v)).digest("hex");
function signature(context:ClaimRow) {
  const secret=process.env.AUTH_SESSION_SECRET;if(!secret)throw new ClaimError("Confirmação indisponível por configuração.",503);
  return createHmac("sha256",secret).update(canonical(context)).digest("hex");
}
function verify(context:ClaimRow,token:string) {
  const expected=Buffer.from(signature(context)); const supplied=Buffer.from(token || "");
  if(expected.length!==supplied.length || !timingSafeEqual(expected,supplied)) throw new ClaimError("Confirmação inválida. Reabra a ação.",400);
}
export async function loadClaimCase(id:string,db=supabaseAdmin()) {
  if(!uuid.test(id))throw new ClaimError("Caso inválido.",400);
  const result=await db.from("marketplace_cases").select("id,marketplace,marketplace_account_id,case_type,external_case_id,order_id,content,updated_at")
    .eq("id",id).eq("marketplace","mercado_livre").eq("case_type","claim").maybeSingle().throwOnError();
  if(!result.data)throw new ClaimError("Reclamação não encontrada.",404);
  return result.data as ClaimRow;
}
async function accountFor(row:ClaimRow) {
  const account=await getMercadoLivreAccountById(row.marketplace_account_id);
  if(!account.active)throw new ClaimError("Conta Mercado Livre inativa.");
  return account;
}
function confirmationContext(row:ClaimRow,account:ClaimRow,bundle:ClaimRow,userId:string,action:ClaimAction) {
  const buyer=bundle.__case_enrichment?.buyer || {};
  return {caseId:row.id,claimId:String(bundle.id),orderId:row.order_id,buyerId:claimBuyerId(bundle),sellerId:String(account.seller_id || account.account_id),
    userId,action,revision:bundle.last_updated,buyerName:buyer.display_name || buyer.nickname || buyer.id,
    currency:buyer.currency,orderAmount:buyer.order_amount,paidAmount:buyer.paid_amount,products:buyer.products || [],expiresAt:Date.now()+5*60_000};
}
export async function prepareClaimAction(id:string,action:ClaimAction,userId:string) {
  const row=await loadClaimCase(id),account=await accountFor(row);
  const bundle=await loadMercadoLivreClaimBundle(row.external_case_id,account);
  const context=confirmationContext(row,account,bundle,userId,action);
  validateClaimAction(bundle,context,action);
  if(!context.currency || !Number.isFinite(context.orderAmount) || !Number.isFinite(context.paidAmount) || !context.products.length)
    throw new ClaimError("Os dados da compra estão incompletos. Atualize o caso antes de confirmar uma ação.");
  const offers=action === "allow_partial_refund" ? await getMercadoLivreResource(`/post-purchase/v1/claims/${row.external_case_id}/partial-refund/available-offers`,account) : null;
  return {context,token:signature(context),offers:offers ? validPartialOffers(offers) : [],currency:offers?.currency_id || context.currency};
}
export async function queueClaimOperation(id:string,input:ClaimRow,userId:string,operatorName:string,db=supabaseAdmin()) {
  if(!uuid.test(input.operationId || ""))throw new ClaimError("Identificação da operação inválida.",400);
  const context=input.context || {};verify(context,input.token);
  if(context.caseId!==id || context.userId!==userId)throw new ClaimError("Confirmação de outro caso ou operador.",403);
  const parameters=context.action === "allow_partial_refund" ? {offer:input.parameters?.offer} : context.action === "send_message_to_complainant" ? {message:input.parameters?.message} : {};
  claimPayload(context.action,parameters);
  const previous=await db.from("outgoing_marketplace_activities").select("id,activity_type,source_id,requested_data")
    .eq("id",input.operationId).maybeSingle().throwOnError();
  if(previous.data) {
    if(previous.data.activity_type!=="claim_action" || previous.data.source_id!==id || previous.data.requested_data?.operatorId!==userId
      || previous.data.requested_data?.action!==context.action || canonical(previous.data.requested_data?.parameters)!==canonical(parameters)) throw new ClaimError("Esta identificação já pertence a outra operação.");
    return String(previous.data.id);
  }
  if(context.expiresAt<Date.now())throw new ClaimError("A confirmação expirou. Reabra a ação.");
  const row=await loadClaimCase(id,db),account=await accountFor(row);
  const bundle=await loadMercadoLivreClaimBundle(row.external_case_id,account);
  validateClaimAction(bundle,context,context.action);
  const fresh=confirmationContext(row,account,bundle,userId,context.action);
  if(context.revision!==fresh.revision || context.currency!==fresh.currency || context.orderAmount!==fresh.orderAmount || context.paidAmount!==fresh.paidAmount
    || canonical(context.products)!==canonical(fresh.products))throw new ClaimError("Os dados mudaram. Reabra a ação e confira novamente.");
  if(context.action === "allow_partial_refund") validatePartialOffer(await getMercadoLivreResource(`/post-purchase/v1/claims/${row.external_case_id}/partial-refund/available-offers`,account),parameters.offer);
  const requested={action:context.action,context,parameters,operatorId:userId,operatorName,requestedAt:new Date().toISOString(),operationId:input.operationId,
    fingerprint:digest([row.marketplace_account_id,id,context.revision,context.action,parameters])};
  const result=await db.rpc("enqueue_marketplace_claim_operation",{p_case_id:id,p_operation_id:input.operationId,p_request:requested});
  if(result.error)throw new ClaimError(/unique|active/i.test(result.error.message) ? "Já existe uma operação em processamento nesta reclamação. Aguarde a confirmação." : "Não foi possível registrar a operação. Atualize o caso.");
  return String(result.data);
}
export async function persistClaimBundle(row:ClaimRow,bundle:ClaimRow,key:string,db=supabaseAdmin()) {
  const observation=normalizeCase({id:key,marketplace:"mercado_livre",received_at:new Date().toISOString(),raw_payload:{topic:"post_purchase",claim_id:row.external_case_id}},row.marketplace_account_id,bundle);
  if(observation)await persistCaseObservation(observation,db);
}
function safeResponse(value:any):any {
  if(Array.isArray(value))return value.slice(0,100).map(safeResponse);
  if(value && typeof value === "object")return Object.fromEntries(Object.entries(value).filter(([key])=>!/token|secret|authorization|cookie/i.test(key)).map(([key,v])=>[key,safeResponse(v)]));
  return typeof value === "string" ? value.replace(/(Bearer\s+)[\w.-]+/gi,"$1[omitido]").slice(0,2000) : value;
}
export async function executeMarketplaceClaimActivity(activity:ClaimRow,db=supabaseAdmin()) {
  const row=await loadClaimCase(String(activity.source_id),db),account=await accountFor(row);
  const read=()=>loadMercadoLivreClaimBundle(row.external_case_id,account);
  const audit=async(stage:string,details:ClaimRow)=>{await db.from("outgoing_marketplace_activity_history").insert({activity_id:activity.id,attempt:activity.attempt_count || 0,stage:`claim_${stage}`,status:stage === "confirmed" ? "success" : "processing",
    details:safeResponse({...details,operationId:activity.id,operatorId:activity.requested_data.operatorId,accountId:row.marketplace_account_id,claimId:row.external_case_id,orderId:row.order_id})}).throwOnError();};
  return executeClaimOperation({
    load:async()=>{const result=await db.from("outgoing_marketplace_activities").select("id,requested_data,remote_execution_state").eq("id",activity.id).single().throwOnError();return result.data as ClaimOperation;},
    authorize:async()=>{
      const user=await db.from("app_users").select("id,active").eq("id",activity.requested_data.operatorId).maybeSingle().throwOnError();
      if(!user.data?.active)throw new ClaimError("O operador desta ação está inativo.",403);
    },
    read,
    offers:()=>getMercadoLivreResource(`/post-purchase/v1/claims/${row.external_case_id}/partial-refund/available-offers`,account),
    baseline:async baseline=>{await db.from("outgoing_marketplace_activities").update({requested_data:{...activity.requested_data,baseline}}).eq("id",activity.id).eq("remote_execution_state","not_started").throwOnError();},
    begin:async()=>Boolean((await db.rpc("begin_marketplace_claim_send",{p_operation_id:activity.id}).throwOnError()).data),
    send:async(endpoint,payload)=>{
      const token=await getValidMercadoLivreAccessToken(account);
      const response=await fetch(`https://api.mercadolibre.com${endpoint}`,{method:"POST",headers:{authorization:`Bearer ${token}`,...(payload ? {"content-type":"application/json"} : {})},
        body:payload ? JSON.stringify(payload) : undefined,signal:AbortSignal.timeout(20000),cache:"no-store"});
      const result=await response.json().catch(()=>({}));
      await audit("remote_response",{endpoint,httpStatus:response.status,response:safeResponse(result)});
      if(!response.ok)throw new ClaimRemoteError(response.status);
      return safeResponse(result);
    },
    acknowledge:async response=>{await db.from("outgoing_marketplace_activities").update({remote_execution_state:"succeeded",confirmed_data:{remote_response:response},updated_at:new Date().toISOString()}).eq("id",activity.id).throwOnError();},
    reject:async(message,afterSend)=>{await db.from("outgoing_marketplace_activities").update({remote_execution_state:"rejected",status:"error",processing_error:message,updated_at:new Date().toISOString()}).eq("id",activity.id).eq("remote_execution_state",afterSend ? "sending" : "not_started").throwOnError();},
    uncertain:async()=>{await db.from("outgoing_marketplace_activities").update({remote_execution_state:"uncertain",updated_at:new Date().toISOString()}).eq("id",activity.id).eq("remote_execution_state","sending").throwOnError();},
    persist:bundle=>persistClaimBundle(row,bundle,`operation:${activity.id}:confirmation:${digest(bundle.__case_enrichment)}`,db),
    complete:async bundle=>{await db.from("outgoing_marketplace_activities").update({remote_execution_state:"confirmed",status:"completed",processing_error:null,
      confirmed_data:{claimId:row.external_case_id,status:bundle.status,revision:bundle.last_updated},processed_at:new Date().toISOString(),updated_at:new Date().toISOString()}).eq("id",activity.id).throwOnError();},audit
  });
}
// Uses the existing worker safety-net cadence, not a browser sync or another queue.
export async function reconcileMarketplaceClaims(db=supabaseAdmin()) {
  const pending=await db.from("outgoing_marketplace_activities").select("id,source_id,requested_data,attempt_count")
    .eq("activity_type","claim_action").in("remote_execution_state",["sending","uncertain","succeeded"]).lt("updated_at",new Date(Date.now()-60000).toISOString()).order("updated_at").limit(10).throwOnError();
  for(const operation of pending.data || [])try{await executeMarketplaceClaimActivity(operation,db);}catch{await db.from("outgoing_marketplace_activities").update({updated_at:new Date().toISOString()}).eq("id",operation.id).throwOnError();}
  // Open-case safety checks moved to the hourly incoming queue. Uncertain financial
  // confirmation retains the existing faster cadence and never replays a POST.
  return {operations:pending.data?.length || 0,cases:0};
}
