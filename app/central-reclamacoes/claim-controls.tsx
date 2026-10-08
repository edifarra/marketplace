"use client";
import { useEffect,useRef,useState } from "react";
import { useRouter } from "next/navigation";
import { CLAIM_ACTION_LABELS,ClaimAction } from "@/lib/marketplace-claim-domain";
import { caseMoney } from "./case-display";
import styles from "./cases.module.css";
type Row=Record<string,any>;
export function ClaimControls({id,data,mode,onChange}:{id:string;data:Row;mode:"chat"|"actions";onChange:(value:Row)=>void}) {
  const router=useRouter();const [modal,setModal]=useState<Row|null>(null),[selected,setSelected]=useState(""),[message,setMessage]=useState("");
  const [busy,setBusy]=useState(false),[error,setError]=useState(""),[operation,setOperation]=useState<string|null>(null),[status,setStatus]=useState("");
  const mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{if(data.pendingOperation?.id)setOperation(data.pendingOperation.id);},[data.pendingOperation?.id]);
  useEffect(()=>{
    if(!operation)return;
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;let stopped=false;const until=Date.now()+120000;
    async function check(){try{
      const response=await fetch(`/api/central-reclamacoes/${id}/operations/${operation}`,{cache:"no-store",signal:controller.signal});
      const result=await response.json();if(!response.ok)throw new Error(result.error);
      if(stopped)return;
      if(result.remote_execution_state === "confirmed") {setOperation(null);setStatus("Operação confirmada no Mercado Livre.");setMessage("");onChange(result.detail);router.refresh();return;}
      if(result.remote_execution_state === "rejected") {setOperation(null);setError(result.processing_error || "A ação foi recusada. Atualize o caso.");router.refresh();return;}
      setStatus(result.remote_execution_state === "not_started" ? "Operação na fila. Aguardando o processamento." : "Confirmando o resultado no Mercado Livre. Não é necessário reenviar.");
    }catch(e){if(!controller.signal.aborted)setError(e instanceof Error ? e.message : "Confirmação local indisponível.");}
      if(!stopped && Date.now()<until)timer=setTimeout(check,1500);
    }
    void check();return()=>{stopped=true;controller.abort();clearTimeout(timer);};
  },[operation,id,onChange,router]);
  const capabilities=data.row.status === "opened" ? data.actions || [] : [];
  const available=(action:string)=>capabilities.some((a:Row)=>a.action_code === action);
  async function prepare(action:ClaimAction){
    setBusy(true);setError("");setStatus("");
    try{const response=await fetch(`/api/central-reclamacoes/${id}/actions?action=${action}`,{cache:"no-store"});const result=await response.json();if(!response.ok)throw new Error(result.error);
      if(mounted.current){setModal({...result,operationId:crypto.randomUUID(),action});setSelected("");}
    }catch(e){if(mounted.current)setError(e instanceof Error ? e.message : "Não foi possível consultar a ação.");}finally{if(mounted.current)setBusy(false);}
  }
  async function submit(){
    if(!modal)return;const offer=modal.offers?.[Number(selected)-1];
    if(modal.action === "allow_partial_refund" && (!selected || !offer)){setError("Selecione uma oferta.");return;}
    setBusy(true);setError("");
    try{const response=await fetch(`/api/central-reclamacoes/${id}/actions`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({operationId:modal.operationId,context:modal.context,token:modal.token,
      parameters:modal.action === "allow_partial_refund" ? {offer:{percentage:offer.percentage,amount:offer.amount,currency:modal.currency}} : modal.action === "send_message_to_complainant" ? {message} : {}})});
      const result=await response.json();if(!response.ok)throw new Error(result.error);
      if(mounted.current){setOperation(result.operationId);onChange({...data,pendingOperation:{id:result.operationId}});setModal(null);setStatus("Operação registrada. Aguardando confirmação.");}
    }catch(e){if(mounted.current)setError(e instanceof Error ? e.message : "Não foi possível confirmar o registro. Tente novamente com esta mesma confirmação.");}finally{if(mounted.current)setBusy(false);}
  }
  return <div>
    {mode === "chat" ? available("send_message_to_complainant") && <div className={styles.reply}><label>Mensagem ao comprador<textarea maxLength={4000} value={message} onChange={e=>setMessage(e.target.value)} disabled={busy || Boolean(operation)} rows={3}/></label><button type="button" className="primary" disabled={busy || Boolean(operation) || !message.trim()} onClick={()=>prepare("send_message_to_complainant")}>Enviar mensagem</button></div>
      : <><div className={styles.actionButtons}>{(["refund","allow_partial_refund","allow_return"] as ClaimAction[]).filter(available).map(action=><button type="button" className="secondary" key={action} disabled={busy || Boolean(operation)} onClick={()=>prepare(action)}>{CLAIM_ACTION_LABELS[action]}</button>)}</div>{available("open_dispute") && <p className="muted">Para abertura de disputa é necessário iniciar a mediação com o Mercado Livre.</p>}{!capabilities.length && <p className="muted">Nenhuma ação disponível no momento.</p>}</>}
    {busy && !modal && <p role="status">Consultando as opções disponíveis…</p>}{status && <p role="status">{status}</p>}{error && <p className="form-error" role="alert">{error}</p>}
    {modal && <div className={styles.modalBackdrop}><section className={styles.modal} role="dialog" aria-modal="true" aria-labelledby={`confirm-${mode}`}><h2 id={`confirm-${mode}`}>{CLAIM_ACTION_LABELS[modal.action as ClaimAction]}</h2>
      <p>Comprador: <strong>{modal.context.buyerName}</strong></p><p>Pedido #{modal.context.orderId} · Reclamação #{modal.context.claimId}</p>
      <p>{modal.context.products.map((p:Row)=>`${p.title} · ${p.quantity} unidade(s)`).join("; ")}</p><p>Produto: {caseMoney(modal.context.orderAmount,modal.context.currency)} · Total pago: {caseMoney(modal.context.paidAmount,modal.context.currency)} · Moeda: {modal.context.currency}</p>
      {modal.action === "allow_partial_refund" ? <><label>Escolha a oferta<select value={selected} onChange={e=>setSelected(e.target.value)} disabled={busy}><option value="">Selecione explicitamente</option>{modal.offers.map((o:Row,index:number)=><option key={index} value={String(index+1)}>{o.percentage}% · {o.amount.toLocaleString("pt-BR",{style:"currency",currency:modal.currency})}</option>)}</select></label><p>O comprador receberá uma oferta. O reembolso parcial depende do aceite.</p></>
        : modal.action === "refund" ? <p>Confirmar executará o reembolso total definido pelo Mercado Livre e encerrará a reclamação. Produto e frete podem ter tratamento diferente; os valores da compra acima não representam uma oferta parcial.</p>
          : modal.action === "allow_return" ? <p>Confirmar oferecerá a devolução do produto. O Mercado Livre gerenciará a logística de retorno e o reembolso conforme esse fluxo.</p> : <p className={styles.messageText}>{message}</p>}
      {error && <p role="alert" className="form-error">{error}</p>}<div className="form-actions"><button className="secondary" type="button" onClick={()=>setModal(null)} disabled={busy}>Cancelar</button><button className="primary" type="button" onClick={submit} disabled={busy || (modal.action === "allow_partial_refund" && !selected) || (modal.action === "allow_partial_refund" && !modal.offers.length)}>{busy ? "Registrando…" : "Confirmar e enviar"}</button></div>
    </section></div>}
  </div>;
}
