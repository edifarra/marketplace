import Link from "next/link";
import { Sidebar } from "@/app/components/sidebar";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { latestConversationCursor } from "@/lib/marketplace-conversation-delta";
import { ConversationView, prepareConversationRows, rowMatchesConversationView, sortConversationRows } from "@/lib/marketplace-conversation-view";
import { ConversationGrid } from "./conversation-grid";

export const dynamic = "force-dynamic";
const PAGE_SIZE = 25;
type Params = { page?: string; tab?: string; marketplace?: string; store?: string; status?: string; sla?: string; search?: string; from?: string; to?: string; unread?: string };

export default async function ChatsQuestionsPage({ searchParams }: { searchParams?: Params }) {
  const db = supabaseAdmin();
  const page = Math.max(1, Number(searchParams?.page || 1));
  const tab = searchParams?.tab === "all" ? "all" : "today";
  const filters = {
    marketplace: String(searchParams?.marketplace || ""), store: String(searchParams?.store || ""), status: String(searchParams?.status || ""),
    sla: String(searchParams?.sla || ""), search: String(searchParams?.search || "").trim(), from: String(searchParams?.from || ""),
    to: String(searchParams?.to || ""), unread: String(searchParams?.unread || "")
  };
  // Captura o watermark antes do snapshot: mudanças concorrentes podem ser repetidas no delta, nunca perdidas.
  const cursorResult = await db.from("marketplace_conversations").select("id,updated_at")
    .order("updated_at", { ascending: false }).order("id", { ascending: false }).limit(1);
  const [conversations, accounts, settings] = await Promise.all([
    db.from("marketplace_conversations").select("*,config_marketplace_accounts(name,nickname,shop_id),marketplace_conversation_messages(*)").order("last_message_at", { ascending: false, nullsFirst: false }).limit(5000),
    db.from("config_marketplace_accounts").select("id,name,nickname,marketplace").eq("active", true).order("name"),
    db.from("settings").select("key,value").in("key", ["CHAT_SLA_WITH_PRODUCT_HOURS", "CHAT_SLA_WITHOUT_PRODUCT_HOURS"])
  ]);
  const setting = (key: string, fallback: number) => { const value = settings.data?.find(row => row.key === key)?.value; const number = Number(value); return Number.isFinite(number) && number > 0 ? number : fallback; };
  const withProduct = setting("CHAT_SLA_WITH_PRODUCT_HOURS", 1), withoutProduct = setting("CHAT_SLA_WITHOUT_PRODUCT_HOURS", 6);
  const allRows = prepareConversationRows(conversations.data || [], withProduct, withoutProduct);
  const view: ConversationView = { ...filters, tab };
  const filtered = allRows.filter(row => rowMatchesConversationView(row, view)).sort(sortConversationRows);
  const total = filtered.length, pages = Math.max(1, Math.ceil(total / PAGE_SIZE)), currentPage = Math.min(page, pages), from = (currentPage - 1) * PAGE_SIZE;
  const rows = filtered.slice(from, from + PAGE_SIZE);
  const error = conversations.error || accounts.error || settings.error || cursorResult.error;

  return <main className="shell"><Sidebar/><section className="main">
    <div className="topbar"><div><h1>Chats e Perguntas</h1><div className="subtitle">Atendimento unificado do Mercado Livre e da Shopee.</div></div></div>
    {error && <div className="form-error">{error.message}</div>}
    <section className="card form-card"><form method="get"><input type="hidden" name="tab" value={tab}/>
      <div className="table-toolbar"><div><h2>Filtros</h2><div className="muted">Localize atendimentos por loja, situação, SLA ou produto.</div></div><div className="row-actions"><button className="secondary">Aplicar</button><a className="secondary link-button" href="/chats-perguntas">Limpar</a></div></div>
      <div className="form-grid chat-filter-grid">
        <label>Marketplace<select name="marketplace" defaultValue={filters.marketplace}><option value="">Todos</option><option value="mercado_livre">Mercado Livre</option><option value="shopee">Shopee</option></select></label>
        <label>Loja<select name="store" defaultValue={filters.store}><option value="">Todas</option>{(accounts.data || []).map(account => <option key={account.id} value={account.id}>{account.nickname || account.name}</option>)}</select></label>
        <label>Situação<select name="status" defaultValue={filters.status}><option value="">Todas</option><option value="pending">Pendente</option><option value="answered">Respondida</option><option value="closed">Encerrada</option><option value="review">Em revisão</option><option value="blocked">Spam/Bloqueada</option><option value="error">Erro</option></select></label>
        <label>SLA<select name="sla" defaultValue={filters.sla}><option value="">Todos</option><option value="inside">Dentro do SLA</option><option value="outside">Fora do SLA</option></select></label>
        <label>Busca<input name="search" defaultValue={filters.search} placeholder="SKU, título, cliente ou pedido"/></label>
        <label>De<input type="date" name="from" defaultValue={filters.from}/></label><label>Até<input type="date" name="to" defaultValue={filters.to}/></label>
        <label className="checkbox-label"><input type="checkbox" name="unread" value="1" defaultChecked={Boolean(filters.unread)}/> Somente não lidas</label>
      </div>
    </form></section>
    <section className="card"><nav className="conversation-tabs" aria-label="Período dos chats"><Link className={tab === "today" ? "active" : ""} href={href(1, filters, "today")}>Atendendo hoje</Link><Link className={tab === "all" ? "active" : ""} href={href(1, filters, "all")}>Todos os chats</Link></nav><div className="muted">Registros {total ? from + 1 : 0}-{Math.min(from + PAGE_SIZE, total)} de {total}</div><ConversationGrid rows={rows} initialCursor={latestConversationCursor(cursorResult.data || [])} view={view} pageSize={PAGE_SIZE}/>
      <div className="form-actions"><Link className="secondary" href={href(Math.max(1, currentPage - 1), filters, tab)}>Anterior</Link><span>Página {currentPage} de {pages}</span><Link className="secondary" href={href(Math.min(pages, currentPage + 1), filters, tab)}>Próxima</Link></div>
    </section>
  </section></main>;
}

function href(page: number, filters: Record<string, string>, tab: string) { return `/chats-perguntas?${new URLSearchParams({ ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value)), tab, page: String(page) })}`; }
