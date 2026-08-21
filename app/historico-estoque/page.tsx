import { Sidebar } from "@/app/components/sidebar";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { InventoryLastQuery } from "./inventory-last-query";

export const dynamic = "force-dynamic";

export default async function InventoryHistoryPage({ searchParams }: { searchParams?: { busca?: string; produto?: string } }) {
  const db = supabaseAdmin();
  const search = String(searchParams?.busca || "").trim();
  const productId = String(searchParams?.produto || "").trim();
  let products: Array<{ id: string; sku: string; title: string }> = [];
  if (productId) {
    const result = await db.from("products").select("id,sku,title").eq("id", productId).limit(1).throwOnError();
    products = result.data || [];
  } else if (search) {
    const escaped = search.replace(/[%_,()]/g, "");
    const result = await db.from("products").select("id,sku,title")
      .or(`sku.ilike.%${escaped}%,title.ilike.%${escaped}%`).order("sku").limit(30).throwOnError();
    products = result.data || [];
  }
  const selected = productId ? products[0] : products.length === 1 ? products[0] : null;
  let stock: { estoque_fisico: number; estoque_disponivel: number } | null = null;
  let movementRows: Array<{ id: string; tipo: string; descricao: string; quantidade: number; estoque_fisico_anterior: number; estoque_fisico_atual: number; estoque_disponivel_anterior: number; estoque_disponivel_atual: number; actor_name: string; created_at: string; metadata: unknown }> = [];
  if (selected) {
    const [currentStock, movements] = await Promise.all([
      db.from("estoque").select("estoque_fisico,estoque_disponivel").eq("product_id", selected.id).maybeSingle().throwOnError(),
      db.from("estoque_movimentacao").select("id,tipo,descricao,quantidade,estoque_fisico_anterior,estoque_fisico_atual,estoque_disponivel_anterior,estoque_disponivel_atual,actor_name,created_at,metadata")
        .eq("product_id", selected.id).order("created_at", { ascending: false }).order("id", { ascending: false }).throwOnError()
    ]);
    stock = currentStock.data;
    movementRows = movements.data || [];
  }

  const currentQuery = productId
    ? `produto=${encodeURIComponent(productId)}`
    : search
      ? `busca=${encodeURIComponent(search)}`
      : "";

  return <main className="shell"><InventoryLastQuery currentQuery={currentQuery} /><Sidebar /><section className="main">
    <div className="topbar"><div><h1>Estoque</h1><div className="subtitle">Histórico contínuo do estoque físico e disponível por produto.</div></div></div>
    <section className="card form-card">
      <form method="get" className="price-search">
        <label>SKU ou nome do produto<input name="busca" defaultValue={search} placeholder="Informe o SKU ou nome" autoFocus={!productId} /></label>
        <button className="primary" type="submit">Buscar</button>
      </form>
    </section>
    {!productId && !search && <section className="section card">Informe um produto ou SKU para consultar o histórico.</section>}
    {!selected && search && products.length === 0 && <section className="section card">Nenhum produto encontrado.</section>}
    {!selected && products.length > 1 && <section className="section card"><h2>Produtos encontrados</h2><div className="table-wrap"><table><thead><tr><th>SKU</th><th>Produto</th><th>Ação</th></tr></thead><tbody>{products.map(product => <tr key={product.id}><td>{product.sku}</td><td>{product.title}</td><td><a className="secondary compact" href={`/historico-estoque?produto=${product.id}`}>Ver histórico</a></td></tr>)}</tbody></table></div></section>}
    {selected && <>
      <section className="section card"><div className="table-toolbar"><div><h2>{selected.sku} — {selected.title}</h2><div className="muted">Posição atual</div></div><div className="row-actions"><strong>Físico: {stock?.estoque_fisico ?? 0}</strong><strong>Disponível: {stock?.estoque_disponivel ?? 0}</strong></div></div></section>
      <section className="section card"><h2>Histórico de Estoque</h2><div className="table-wrap"><table><thead><tr><th>Data do evento</th><th>Descrição</th><th>Responsável</th><th>Movimento</th><th>Estoque físico</th><th>Estoque disponível</th></tr></thead><tbody>
        {movementRows.length === 0 ? <tr><td colSpan={6}>Ainda não há movimentações registradas.</td></tr> : movementRows.map(row => <tr key={row.id}><td>{formatDate(row.created_at)}</td><td>{row.descricao}<OrderInfo metadata={row.metadata} /></td><td>{row.actor_name}</td><td>{Number(row.quantidade) > 0 ? "+" : ""}{row.quantidade}</td><td>{row.estoque_fisico_anterior} → <strong>{row.estoque_fisico_atual}</strong></td><td>{row.estoque_disponivel_anterior} → <strong>{row.estoque_disponivel_atual}</strong></td></tr>)}
      </tbody></table></div></section>
    </>}
  </section></main>;
}

function OrderInfo({ metadata }: { metadata: unknown }) {
  const value = (metadata || {}) as { marketplace?: string; order_id?: string };
  return value.order_id ? <div className="muted">{value.marketplace || "Marketplace"} · Pedido {value.order_id}</div> : null;
}
function formatDate(value: string) { return new Date(value).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" }); }
