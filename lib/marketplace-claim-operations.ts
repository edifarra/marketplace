import { ClaimAction, ClaimError, ClaimRow, claimEndpoint, claimPayload, validateClaimAction, validatePartialOffer,stableClaimValue } from "./marketplace-claim-domain";
export type ClaimOperation = ClaimRow & { id: string; requested_data: ClaimRow; remote_execution_state: string };
export class ClaimRemoteError extends ClaimError {
  constructor(status: number) { super(status === 401 || status === 403 ? "O Mercado Livre recusou a autorização. Verifique a conexão da conta." : status === 400 || status === 422 ? "O Mercado Livre recusou a ação ou a oferta. Atualize o caso." : "O Mercado Livre está indisponível. A confirmação do envio está pendente.",status,status >= 500 || status === 408); }
}
export function operationBaseline(bundle: ClaimRow) {
  const extra=bundle.__case_enrichment || {};
  return { messages:(extra.messages || []).map((m:ClaimRow)=>String(m.hash || m.id || JSON.stringify([m.sender_role,m.message_date,m.message]))),
    actions:(extra.actions || []).map((a:ClaimRow)=>stableClaimValue(a)),resolutions:(extra.resolutions || []).map((r:ClaimRow)=>stableClaimValue(r)),returnId:extra.return?.id || null };
}
export function claimOutcomeConfirmed(operation: ClaimOperation, bundle: ClaimRow) {
  const request=operation.requested_data, baseline=request.baseline || {}, extra=bundle.__case_enrichment || {};
  if(request.action === "send_message_to_complainant") return (extra.messages || []).some((m:ClaimRow)=>m.sender_role === "respondent" && m.receiver_role === "complainant"
    && m.status === "available" && String(m.message).trim() === request.parameters.message.trim()
    && !(baseline.messages || []).includes(String(m.hash || m.id || JSON.stringify([m.sender_role,m.message_date,m.message]))));
  if(request.action === "allow_return") return Boolean(extra.return?.id && String(extra.return.id)!==String(baseline.returnId))
    || (extra.actions || []).some((a:ClaimRow)=>a.player_role === "respondent" && a.action_name === "allow_return" && !(baseline.actions || []).includes(stableClaimValue(a)));
  if(request.action === "refund") return bundle.status === "closed" && (bundle.resolution?.reason === "payment_refunded"
    || (extra.resolutions || []).some((r:ClaimRow)=>r.player_role === "respondent" && r.expected_resolution === "refund" && r.status === "accepted" && !(baseline.resolutions || []).includes(stableClaimValue(r))));
  if(request.action === "allow_partial_refund") return (extra.resolutions || []).some((r:ClaimRow)=>r.player_role === "respondent" && r.expected_resolution === "partial_refund"
    && ["pending","accepted"].includes(r.status) && !(baseline.resolutions || []).includes(stableClaimValue(r))
    && (r.details || r.detail || []).some((d:ClaimRow)=>d.key === "percentage" && Number(d.value) === request.parameters.offer.percentage));
  return false;
}
export type ClaimOperationDependencies = {
  authorize?: () => Promise<void>;
  load: () => Promise<ClaimOperation>; read: () => Promise<ClaimRow>; offers: () => Promise<ClaimRow>;
  baseline: (value: ClaimRow) => Promise<void>; begin: () => Promise<boolean>;
  send: (endpoint: string, payload?: ClaimRow) => Promise<unknown>; acknowledge: (response: unknown) => Promise<void>;
  reject: (message: string, afterSend?: boolean) => Promise<void>; uncertain: () => Promise<void>;
  persist: (bundle: ClaimRow) => Promise<void>; complete: (bundle: ClaimRow) => Promise<void>;
  audit: (stage: string, details: ClaimRow) => Promise<void>;
};
export async function executeClaimOperation(deps: ClaimOperationDependencies) {
  let operation=await deps.load();
  if(operation.remote_execution_state === "confirmed") return {confirmed:true,reconciled:true};
  if(operation.remote_execution_state === "rejected") throw new ClaimError("A operação foi recusada. Atualize o caso para iniciar outra operação.");
  const request=operation.requested_data;
  if(operation.remote_execution_state === "not_started") {
    try {
      await deps.authorize?.();
      const bundle=await deps.read();
      validateClaimAction(bundle,request.context,request.action);
      const buyer=bundle.__case_enrichment?.buyer || {};
      if(bundle.last_updated !== request.context.revision || buyer.currency !== request.context.currency || buyer.order_amount !== request.context.orderAmount
        || buyer.paid_amount !== request.context.paidAmount || JSON.stringify(buyer.products)!==JSON.stringify(request.context.products)) throw new ClaimError("O pedido ou a reclamação mudou após a confirmação. Reabra a ação.");
      if(request.action === "allow_partial_refund") validatePartialOffer(await deps.offers(),request.parameters.offer);
      claimPayload(request.action,request.parameters);
      await deps.baseline(operationBaseline(bundle));
      await deps.audit("revalidated",{action:request.action,context:request.context,parameters:request.parameters});
    } catch(error) {
      if(error instanceof ClaimError && !error.uncertain && error.status < 500) await deps.reject(error.message);
      throw error;
    }
    if(!await deps.begin()) throw new ClaimError("Operação já em processamento. Aguardando confirmação.",202,true);
    // The durable 'sending' marker exists before the only POST; no error path resets it to not_started.
    const endpoint=claimEndpoint(request.context.claimId,request.action as ClaimAction);
    try {
      const response=await deps.send(endpoint,claimPayload(request.action,request.parameters));
      await deps.acknowledge(response);
      await deps.audit("remote_accepted",{endpoint});
    } catch(error) {
      if(error instanceof ClaimRemoteError && error.status >= 400 && error.status < 500 && !error.uncertain) await deps.reject(error.message,true);
      else await deps.uncertain();
      throw error instanceof ClaimError ? error : new ClaimError("O resultado do envio é indeterminado. A confirmação será feita por consulta, sem repetir o envio.",202,true);
    }
  }
  operation=await deps.load();
  try {
    const bundle=await deps.read();
    // Identity remains enforced for confirmation even after the capability has disappeared/claim closed.
    if(String(bundle.id)!==request.context.claimId || String(bundle.resource_id)!==request.context.orderId) throw new ClaimError("Identidade divergente na confirmação.");
    await deps.persist(bundle);
    if(!claimOutcomeConfirmed(operation,bundle)) throw new ClaimError("Aguardando confirmação do Mercado Livre. O envio não será repetido.",202,true);
    await deps.audit("confirmed",{claimId:String(bundle.id),status:bundle.status,revision:bundle.last_updated});
    await deps.complete(bundle);
    return {confirmed:true,reconciled:operation.remote_execution_state !== "succeeded"};
  } catch(error) {
    await deps.audit("confirmation_pending",{message:"Confirmação pendente; POST não será repetido."});
    throw error instanceof ClaimError ? error : new ClaimError("Envio recebido; atualização local pendente. O envio não será repetido.",202,true);
  }
}
