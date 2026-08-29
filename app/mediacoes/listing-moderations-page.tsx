import Link from "next/link";
import { Sidebar } from "@/app/components/sidebar";
import { supabaseAdmin } from "@/lib/supabase-admin";

const PAGE_SIZE = 50;
type Classification = "final" | "review";

export async function ListingModerationsPage({ classification, searchParams }: {
  classification: Classification;
  searchParams?: { page?: string; store?: string; marketplace?: string; search?: string };
}) {
  const requestedPage = Math.max(1, Number(searchParams?.page || 1));
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const filters = { store: String(searchParams?.store || ""), marketplace: String(searchParams?.marketplace || ""), search: String(searchParams?.search || "").trim() };
  const db = supabaseAdmin();
  let countQuery = db.from("marketplace_listing_moderations").select("id", { count: "exact", head: true })
    .eq("classification", classification).gte("event_at", cutoff);
  let dataQuery = db.from("marketplace_listing_moderations").select("*")
    .eq("classification", classification).gte("event_at", cutoff);
  if (filters.store) { countQuery = countQuery.eq("marketplace_account_id", filters.store); dataQuery = dataQuery.eq("marketplace_account_id", filters.store); }
  if (filters.marketplace) { countQuery = countQuery.eq("marketplace", filters.marketplace); dataQuery = dataQuery.eq("marketplace", filters.marketplace); }
  if (filters.search) {
    const term = filters.search.replaceAll(",", " ");
    const expression = `sku.ilike.%${term}%,product_name.ilike.%${term}%,listing_id.ilike.%${term}%`;
    countQuery = countQuery.or(expression); dataQuery = dataQuery.or(expression);
  }
  const [countResult, accountResult] = await Promise.all([
    countQuery,
    db.from("config_marketplace_accounts").select("id,name,nickname,marketplace").order("name")
  ]);
  const count = countResult.count || 0;
  const pages = Math.max(1, Math.ceil(count / PAGE_SIZE));
  const page = Math.min(requestedPage, pages);
  const from = (page - 1) * PAGE_SIZE;
  const rowsResult = await dataQuery.order("event_at", { ascending: false }).range(from, from + PAGE_SIZE - 1);
  const rows = rowsResult.data || [];
  const accounts = accountResult.data || [];
  const isFinal = classification === "final";
  const basePath = isFinal ? "/mediacoes/anuncios-finalizados" : "/mediacoes/anuncios-em-revisao";
  const error = countResult.error || rowsResult.error || accountResult.error;

  return <main className={`shell ${isFinal ? "finalized-listings-page" : "review-listings-page"}`}><Sidebar /><section className="main">
    <div className="topbar"><div><h1>{isFinal ? "Anúncios finalizados" : "Anúncios em revisão"}</h1>
      <div className="subtitle">{isFinal ? "Anúncios encerrados, fechados, removidos ou banidos nos últimos 30 dias." : "Anúncios que podem ser corrigidos, avaliados e reativados. Histórico dos últimos 30 dias."}</div>
    </div></div>
    {error && <div className="form-error">{error.message}</div>}
    <section className="card form-card"><form action={basePath} method="get">
      <div className="table-toolbar"><div><h2>Filtros</h2><div className="muted">Localize por loja, marketplace, SKU, produto ou anúncio.</div></div>
        <div className="row-actions"><button className="primary" type="submit">Aplicar</button><a className="secondary link-button" href={basePath}>Limpar filtros</a></div></div>
      <div className="form-grid">
        <label>Buscar por SKU<input name="search" defaultValue={filters.search} placeholder="Informe o SKU" /></label>
        <label>Loja<select name="store" defaultValue={filters.store}><option value="">Todas</option>{accounts.map(account => <option key={account.id} value={account.id}>{account.nickname || account.name}</option>)}</select></label>
        <label>Marketplace<select name="marketplace" defaultValue={filters.marketplace}><option value="">Todos</option><option value="mercado_livre">Mercado Livre</option><option value="shopee">Shopee</option></select></label>
      </div>
    </form></section>
    <section className="card"><div className="muted">Registro {count ? from + 1 : 0}-{Math.min(from + PAGE_SIZE, count)} de {count.toLocaleString("pt-BR")}</div>
      <div className="table-wrap"><table><thead><tr><th>Loja</th><th>Marketplace</th><th>SKU</th><th>Produto</th><th>Código do anúncio</th><th>Status</th><th>{isFinal ? "Motivo final (razão)" : "Motivo"}</th>{!isFinal && <th>Sugestão</th>}<th>Data/Hora</th></tr></thead><tbody>
        {rows.map(row => <tr key={row.id}><td>{row.store_name}</td><td>{marketplaceLabel(row.marketplace)}</td><td>{row.sku || "-"}</td><td>{row.product_name}</td>
          <td>{row.listing_id}</td><td>{statusLabel(row.marketplace, row.status)}</td><td>{row.reason || "-"}</td>{!isFinal && <td>{cleanSuggestion(row.remedy) || "-"}</td>}
          <td>{new Date(row.event_at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}</td></tr>)}
        {!rows.length && <tr><td colSpan={isFinal ? 8 : 9}>Nenhum anúncio encontrado.</td></tr>}
      </tbody></table></div>
      <div className="form-actions"><Link className="secondary" href={pageHref(basePath, 1, filters)}>«</Link><Link className="secondary" href={pageHref(basePath, Math.max(1, page - 1), filters)}>‹</Link><span>Página {page} de {pages}</span><Link className="secondary" href={pageHref(basePath, Math.min(pages, page + 1), filters)}>›</Link><Link className="secondary" href={pageHref(basePath, pages, filters)}>»</Link></div>
    </section>
  </section></main>;
}

function pageHref(path: string, page: number, filters: Record<string, string>) {
  return `${path}?${new URLSearchParams({ ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value)), page: String(page) })}`;
}
function marketplaceLabel(value: string) { return value === "shopee" ? "Shopee" : "Mercado Livre"; }
function statusLabel(marketplace: string, status: string) {
  const labels: Record<string, string> = { closed: "Fechado", inactive: "Inativo", under_review: "Em revisão", SHOPEE_DELETE: "Removido pela Shopee", SELLER_DELETE: "Excluído pelo vendedor", DELETED: "Excluído", BANNED: "Banido", REVIEWING: "Em revisão" };
  return labels[status] || labels[String(status).toUpperCase()] || status;
}
function cleanSuggestion(value: string | null) { return String(value || "").replace(/\{\{text:[\s\S]*?\}\}/g, "Saiba mais na Central do Vendedor").trim(); }
