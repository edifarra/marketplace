import { Sidebar } from "@/app/components/sidebar";
import { PendingSubmitButton } from "@/app/components/pending-submit-button";
import { requireMaster } from "@/lib/auth";
import { getTelegramConfig } from "@/lib/telegram-notifications";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { redirect } from "next/navigation";
import { saveTelegramAction, testTelegramAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function TelegramPage({ searchParams }: { searchParams?: { sucesso?: string; erro?: string } }) {
  if (!(await requireMaster())) redirect("/acesso-negado");
  const config = await getTelegramConfig();
  const history = await supabaseAdmin().from("telegram_notification_history").select("*").order("created_at", { ascending: false }).limit(100);
  return <main className="shell"><Sidebar/><section className="main">
    <div className="topbar"><div><h1>Configurações: Notificações Telegram</h1><div className="subtitle">Conexão segura com o bot e regras dos alertas de vendas e despacho.</div></div></div>
    {searchParams?.sucesso && <div className="form-success">{searchParams.sucesso}</div>}{searchParams?.erro && <div className="form-error">{searchParams.erro}</div>}
    <form action={saveTelegramAction} className="config-form">
      <section className="card form-card"><h2>Configuração do Telegram</h2><div className="form-grid">
        <Toggle name="enabled" label="Ativar notificações Telegram" checked={config.enabled}/>
        <label>Bot Token<input name="botToken" type="password" autoComplete="new-password" placeholder={config.bot_token_encrypted ? "•••••••• (token salvo)" : "Token fornecido pelo BotFather"}/></label>
        <label>Chat ID<input name="chatId" required={config.enabled} defaultValue={config.chat_id || ""}/></label>
        <label>Destinatário<input name="recipientName" defaultValue={config.recipient_name || ""}/></label>
        <label>Fuso horário<input name="timezone" required defaultValue={config.timezone}/></label>
      </div></section>
      <section className="section card form-card"><h2>Alerta de novas vendas</h2><div className="form-grid"><Toggle name="newSaleEnabled" label="Ativar alerta" checked={config.new_sale_enabled}/><label>Horário inicial<input name="newSaleStart" type="time" required defaultValue={config.new_sale_start.slice(0,5)}/></label><label>Horário final<input name="newSaleEnd" type="time" required defaultValue={config.new_sale_end.slice(0,5)}/></label></div></section>
      <section className="section card form-card"><h2>Alerta de pedidos aguardando despacho</h2><div className="form-grid"><Toggle name="dispatchEnabled" label="Ativar alerta" checked={config.dispatch_enabled}/><label>Horário de verificação<input name="dispatchCheckTime" type="time" required defaultValue={config.dispatch_check_time.slice(0,5)}/></label></div></section>
      <div className="form-actions"><button className="primary" type="submit">Salvar configurações</button></div>
    </form>
    <section className="section card form-card"><h2>Testar Telegram</h2><div className="test-row"><form action={testTelegramAction}><PendingSubmitButton className="secondary" pendingLabel="Enviando...">Testar Telegram</PendingSubmitButton></form><div className="muted">Envia “Teste de notificação — Gestão Marketplace .Tech” usando a configuração salva.</div></div></section>
    <section className="section card"><div className="table-toolbar"><div><h2>Histórico de notificações</h2><div className="muted">Últimos 100 registros.</div></div></div><div className="table-wrap"><table><thead><tr><th>Data/Hora</th><th>Tipo</th><th>Pedido</th><th>Marketplace/Conta</th><th>Status</th><th>Erro</th></tr></thead><tbody>
      {(history.data || []).length ? (history.data || []).map((row:any)=><tr key={row.id}><td>{new Intl.DateTimeFormat("pt-BR",{dateStyle:"short",timeStyle:"short",timeZone:config.timezone}).format(new Date(row.created_at))}</td><td>{typeLabel(row.alert_type)}</td><td>{row.order_id || "—"}</td><td>{[row.marketplace,row.account_name].filter(Boolean).join(" / ") || "—"}</td><td>{statusLabel(row.status)}</td><td title={row.error_message || ""}>{row.error_message || "—"}</td></tr>) : <tr><td colSpan={6}>Nenhuma notificação registrada.</td></tr>}
    </tbody></table></div></section>
  </section></main>;
}

function Toggle({name,label,checked}:{name:string;label:string;checked:boolean}) { return <label>{label}<span className="check-row"><input name={name} type="checkbox" defaultChecked={checked}/>{checked ? "Ativado" : "Desativado"}</span></label>; }
function typeLabel(value:string){return value==="new_sale"?"Nova venda":value==="pending_dispatch"?"Aguardando despacho":"Teste";}
function statusLabel(value:string){return value==="sent"?"Enviado":value==="error"?"Erro":"Ignorado/Duplicado";}
