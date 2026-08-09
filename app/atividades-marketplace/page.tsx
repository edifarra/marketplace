import Link from "next/link";
import { Sidebar } from "@/app/components/sidebar";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { activityDescription, activityGroup, activityTypeLabel } from "@/lib/marketplace-activity-labels";

export const dynamic = "force-dynamic";
const PAGE_SIZE = 50;

type Filters = { store: string; order: string; type: string };

export default async function ActivitiesPage({ searchParams }: { searchParams?: { page?: string; store?: string; order?: string; type?: string } }) {
  const page = Math.max(1, Number(searchParams?.page || 1));
  const filters: Filters = { store: String(searchParams?.store || ""), order: String(searchParams?.order || "").trim(), type: String(searchParams?.type || "") };
  const db = supabaseAdmin();
  const retentionCutoff = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
  const [activityResult, accountResult] = await Promise.all([
    db.from("marketplace_activities")
      .select("id,marketplace,event_type,order_id,description,status,item_count,received_at,attempt_count,next_attempt_at,processing_error,raw_payload,venda(raw_data)")
      .gte("received_at", retentionCutoff).order("received_at", { ascending: false }).limit(5000),
    db.from("config_marketplace_accounts").select("id,name,nickname,marketplace,seller_id,account_id,shop_id").eq("active", true).order("name")
  ]);
  const accounts = accountResult.data || [];
  const allRows = (activityResult.data || []).map((row) => ({ ...row, resolvedAccountId: resolveActivityAccount(row, accounts) }));
  const filtered = allRows
    .filter((row) => !filters.store || row.resolvedAccountId === filters.store)
    .filter((row) => !filters.order || String(row.order_id || "").toLocaleUpperCase("pt-BR").includes(filters.order.toLocaleUpperCase("pt-BR")))
    .filter((row) => !filters.type || `${row.marketplace}:${row.event_type}` === filters.type);
  const count = filtered.length;
  const pages = Math.max(1, Math.ceil(count / PAGE_SIZE));
  const currentPage = Math.min(page, pages);
  const from = (currentPage - 1) * PAGE_SIZE;
  const rows = filtered.slice(from, from + PAGE_SIZE);
  const typeOptions = [...new Map(allRows.map((row) => [`${row.marketplace}:${row.event_type}`, {
    value: `${row.marketplace}:${row.event_type}`,
    label: `${activityGroup(row.marketplace, row.event_type)} — ${activityTypeLabel(row.marketplace, row.event_type)}`
  }])).values()].sort((left, right) => left.label.localeCompare(right.label, "pt-BR"));

  return <main className="shell"><Sidebar /><section className="main">
    <div className="topbar"><div><h1>Atividades Marketplace</h1><div className="subtitle">Eventos recebidos e processados, organizados por assunto. Histórico mantido por 60 dias.</div></div></div>
    {(activityResult.error || accountResult.error) && <div className="form-error">{activityResult.error?.message || accountResult.error?.message}</div>}
    <section className="card form-card"><form action="/atividades-marketplace" method="get">
      <div className="table-toolbar"><div><h2>Filtros</h2><div className="muted">Localize atividades por loja, pedido ou tipo.</div></div><div className="row-actions"><button className="secondary" type="submit">Aplicar</button><a className="secondary link-button" href="/atividades-marketplace">Limpar filtros</a></div></div>
      <div className="form-grid">
        <label>Loja<select name="store" defaultValue={filters.store}><option value="">Todas</option>{accounts.map(account => <option key={account.id} value={account.id}>{account.nickname || account.name}</option>)}</select></label>
        <label>Pedido<input name="order" placeholder="ID do pedido" defaultValue={filters.order} /></label>
        <label>Tipo<select name="type" defaultValue={filters.type}><option value="">Todos</option>{typeOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
      </div>
    </form></section>
    <section className="card"><div className="muted">Registro {count ? from + 1 : 0}-{Math.min(from + PAGE_SIZE, count)} de {count.toLocaleString("pt-BR")}</div>
      <div className="table-wrap"><table><thead><tr><th>Loja</th><th>Pedido</th><th>Grupo</th><th>Tipo</th><th>Descrição</th><th>Fila</th><th>Tentativas</th><th>Itens</th><th>Data/Hora</th></tr></thead><tbody>
        {rows.map(row => <tr key={row.id}>
          <td>{accountName(row.resolvedAccountId, accounts) || (row.marketplace === "shopee" ? "Shopee" : "Mercado Livre")}</td>
          <td><Link href={`/atividades-marketplace/${row.id}`}>{row.order_id || "-"}</Link></td>
          <td>{activityGroup(row.marketplace, row.event_type)}</td><td>{activityTypeLabel(row.marketplace, row.event_type)}</td>
          <td>{activityDescription(row.marketplace, row.event_type, row.raw_payload) || row.processing_error || "-"}</td>
          <td>{queueStatusLabel(row.status)}</td><td>{row.attempt_count || 0}</td><td>{row.item_count}</td><td>{new Date(row.received_at).toLocaleString("pt-BR")}</td>
        </tr>)}
        {!rows.length && <tr><td colSpan={9}>Nenhuma atividade encontrada.</td></tr>}
      </tbody></table></div>
      <div className="form-actions"><Link className="secondary" href={pageHref(1, filters)}>Primeira</Link><Link className="secondary" href={pageHref(Math.max(1, currentPage - 1), filters)}>Anterior</Link><span>Página {currentPage} de {pages}</span><Link className="secondary" href={pageHref(Math.min(pages, currentPage + 1), filters)}>Próxima</Link><Link className="secondary" href={pageHref(pages, filters)}>Última</Link></div>
    </section></section></main>;
}

function resolveActivityAccount(row: Record<string, any>, accounts: Array<Record<string, any>>) {
  const saleRaw = (Array.isArray(row.venda) ? row.venda[0]?.raw_data : row.venda?.raw_data) || {};
  const savedId = String(saleRaw.marketplace_account_id || "");
  if (savedId) return savedId;
  const raw = row.raw_payload || {};
  const payload = raw.notification || raw;
  const externalId = String(payload.shop_id || payload.user_id || payload.data?.shop_id || "");
  return String(accounts.find((account) => account.marketplace === row.marketplace && [account.shop_id, account.seller_id, account.account_id].some((id) => String(id || "") === externalId))?.id || "");
}
function accountName(id: string, accounts: Array<Record<string, any>>) { const account = accounts.find((item) => item.id === id); return String(account?.nickname || account?.name || ""); }
function pageHref(page: number, filters: Filters) { return `/atividades-marketplace?${new URLSearchParams({ ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value)), page: String(page) })}`; }
function queueStatusLabel(status: string) { const labels: Record<string, string> = { received: "Recebido", queued: "Na fila", processing: "Processando", retry: "Nova tentativa", processed: "Processado", error: "Erro" }; return labels[status] || status; }
