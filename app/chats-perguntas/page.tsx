import Link from "next/link";
import { Sidebar } from "@/app/components/sidebar";
import { supabaseAdmin } from "@/lib/supabase-admin";
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
  const [conversations, accounts, settings] = await Promise.all([
    db.from("marketplace_conversations").select("*,config_marketplace_accounts(name,nickname,shop_id),marketplace_conversation_messages(*)").order("last_message_at", { ascending: false, nullsFirst: false }).limit(5000),
    db.from("config_marketplace_accounts").select("id,name,nickname,marketplace").eq("active", true).order("name"),
    db.from("settings").select("key,value").in("key", ["CHAT_SLA_WITH_PRODUCT_HOURS", "CHAT_SLA_WITHOUT_PRODUCT_HOURS"])
  ]);
  const setting = (key: string, fallback: number) => { const value = settings.data?.find(row => row.key === key)?.value; const number = Number(value); return Number.isFinite(number) && number > 0 ? number : fallback; };
  const withProduct = setting("CHAT_SLA_WITH_PRODUCT_HOURS", 1), withoutProduct = setting("CHAT_SLA_WITHOUT_PRODUCT_HOURS", 6);
  const individualRows = (conversations.data || []).map((row: any) => {
    const slaHours = row.product_id || row.listing_id ? withProduct : withoutProduct;
    const since = new Date(row.last_incoming_at || row.last_message_at).getTime();
    return { ...row, messages: [...(row.marketplace_conversation_messages || [])].sort(compareMessages), slaHours, slaBreached: row.requires_response && Date.now() - since >= slaHours * 3600000 };
  });
  const allRows = groupMercadoLivreQuestions(individualRows);
  const search = filters.search.toLocaleUpperCase("pt-BR");
  const attendingSince = Date.now() - 24 * 60 * 60 * 1000;
  const filtered = allRows
    .filter(row => tab === "all" || new Date(row.last_message_at).getTime() >= attendingSince)
    .filter(row => !filters.marketplace || row.marketplace === filters.marketplace)
    .filter(row => !filters.store || row.marketplace_account_id === filters.store)
    .filter(row => !filters.status || row.status === filters.status)
    .filter(row => !filters.sla || (filters.sla === "outside" ? row.slaBreached : row.requires_response && !row.slaBreached))
    .filter(row => !filters.unread || row.unread)
    .filter(row => !filters.from || String(row.last_message_at) >= `${filters.from}T00:00:00`)
    .filter(row => !filters.to || String(row.last_message_at) <= `${filters.to}T23:59:59.999`)
    .filter(row => !search || [row.sku, row.product_title, row.buyer_name, row.buyer_id, row.order_id, row.listing_id].some(value => String(value || "").toLocaleUpperCase("pt-BR").includes(search)))
    .sort((a, b) => new Date(b.last_message_at || 0).getTime() - new Date(a.last_message_at || 0).getTime());
  const total = filtered.length, pages = Math.max(1, Math.ceil(total / PAGE_SIZE)), currentPage = Math.min(page, pages), from = (currentPage - 1) * PAGE_SIZE;
  const rows = filtered.slice(from, from + PAGE_SIZE);
  const error = conversations.error || accounts.error || settings.error;

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
    <section className="card"><nav className="conversation-tabs" aria-label="Período dos chats"><Link className={tab === "today" ? "active" : ""} href={href(1, filters, "today")}>Atendendo hoje</Link><Link className={tab === "all" ? "active" : ""} href={href(1, filters, "all")}>Todos os chats</Link></nav><div className="muted">Registros {total ? from + 1 : 0}-{Math.min(from + PAGE_SIZE, total)} de {total}</div><ConversationGrid rows={rows}/>
      <div className="form-actions"><Link className="secondary" href={href(Math.max(1, currentPage - 1), filters, tab)}>Anterior</Link><span>Página {currentPage} de {pages}</span><Link className="secondary" href={href(Math.min(pages, currentPage + 1), filters, tab)}>Próxima</Link></div>
    </section>
  </section></main>;
}

function compareMessages(a: any, b: any) {
  const byDate = new Date(a.sent_at).getTime() - new Date(b.sent_at).getTime();
  if (byDate) return byDate;
  const left = BigInt(String(a.raw_data?.message_id || a.external_message_id || "0").replace(/\D/g, "") || "0");
  const right = BigInt(String(b.raw_data?.message_id || b.external_message_id || "0").replace(/\D/g, "") || "0");
  return left < right ? -1 : left > right ? 1 : 0;
}

function href(page: number, filters: Record<string, string>, tab: string) { return `/chats-perguntas?${new URLSearchParams({ ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value)), tab, page: String(page) })}`; }

function groupMercadoLivreQuestions(rows: any[]) {
  const groups = new Map<string, any[]>();
  for (const row of rows) {
    const key = row.marketplace === "mercado_livre" && row.conversation_type === "question"
      ? `ml:${row.marketplace_account_id}:${row.buyer_id || row.buyer_name}:${row.sku || row.listing_id}`
      : `single:${row.id}`;
    groups.set(key, [...(groups.get(key) || []), row]);
  }
  return [...groups.values()].map(members => {
    if (members.length === 1) return { ...members[0], question_count: members[0].conversation_type === "question" ? 1 : undefined };
    members.sort((a, b) => new Date(a.last_message_at).getTime() - new Date(b.last_message_at).getTime());
    const actionable = [...members].reverse().find(row => row.requires_response) || members[members.length - 1];
    const pending = members.filter(row => row.requires_response);
    const messages = members.flatMap(row => row.messages).sort((a, b) => new Date(a.sent_at).getTime() - new Date(b.sent_at).getTime());
    const firstValue = (field: string) => [...members].reverse().find(row => row[field] != null)?.[field] ?? null;
    const lastIncoming = pending.length ? pending.reduce((latest, row) => new Date(row.last_incoming_at) > new Date(latest) ? row.last_incoming_at : latest, pending[0].last_incoming_at) : firstValue("last_incoming_at");
    return {
      ...actionable,
      question_count: members.length,
      grouped_conversation_ids: members.map(row => row.id),
      grouped_external_ids: members.map(row => row.external_conversation_id),
      messages,
      requires_response: pending.length > 0,
      unread: pending.some(row => row.unread),
      status: pending.length ? "pending" : "answered",
      last_incoming_at: lastIncoming,
      last_outgoing_at: firstValue("last_outgoing_at"),
      last_message_at: firstValue("last_message_at"),
      sku: firstValue("sku"), product_id: firstValue("product_id"), product_title: firstValue("product_title"), product_price: firstValue("product_price"),
      product_image_url: firstValue("product_image_url"), available_stock: firstValue("available_stock"), item_permalink: firstValue("item_permalink"),
      slaBreached: pending.some(row => row.slaBreached)
    };
  });
}
