import Link from "next/link";
import { CaseGrid } from "./case-grid";
import { Sidebar } from "@/app/components/sidebar";
import { CASE_PAGE_SIZE, caseGroup, caseSaleItems, knownCaseDeadlines, loadCaseList, type CaseFilters } from "@/lib/marketplace-case-list";
import styles from "./cases.module.css";

export const dynamic = "force-dynamic";
export const revalidate = 0;
const path = "/central-reclamacoes";
const labels = { action: "Precisa de ação", ongoing: "Em andamento / aguardando", closed: "Encerrado", unknown: "Desconhecido / incompleto" };
function href(filters: CaseFilters, updates: CaseFilters) {
  return `${path}?${new URLSearchParams(Object.entries({ ...filters, ...updates }).filter(([, v]) => Boolean(v)) as [string, string][])}`;
}
export default async function CasesPage({ searchParams = {} }: { searchParams?: CaseFilters }) {
  let result: Awaited<ReturnType<typeof loadCaseList>> | undefined;
  try { result = await loadCaseList(searchParams); } catch { /* Keep failures distinct from an empty list. */ }
  if (!result) return <main className="shell"><Sidebar /><section className="main"><div className="topbar"><h1>Central de Reclamações e Devoluções</h1></div><div className="form-error" role="alert">Não foi possível ler os Casos persistidos. Verifique a conexão e a configuração do Supabase.</div><Link href={path} className="secondary">Tentar novamente</Link></section></main>;
  const { rows, products, accounts, filters, counts, total, page, pages } = result;
  const all = Object.values(counts).reduce((n, v) => n + v, 0);
  const tabs = [{ key: "all", label: "Todos", count: all }, { key: "action", label: "Precisa de ação", count: counts.action }, { key: "ongoing", label: "Em andamento", count: counts.ongoing }, { key: "closed", label: "Encerrados", count: counts.closed }];
  const from = (page - 1) * CASE_PAGE_SIZE;
  return <main className="shell"><Sidebar /><section className="main">
    <div className="topbar"><div><h1>Central de Reclamações e Devoluções</h1><div className="subtitle">Casos registrados · consulta somente leitura</div></div></div>
    <section className="card form-card">
      <nav className={styles.tabs} aria-label="Situação dos Casos">{tabs.map(tab => <Link prefetch={false} key={tab.key} href={href(filters, { tab: tab.key, page: "1" })} className={`${styles.tab} ${filters.tab === tab.key ? styles.active : ""}`} aria-current={filters.tab === tab.key ? "page" : undefined}>{tab.label}<span>{tab.count}</span></Link>)}</nav>
      <form key={JSON.stringify(filters)} action={path} method="get">
        <input type="hidden" name="tab" value={filters.tab}/>
        <div className="form-grid">
          <label>Buscar<input name="search" defaultValue={filters.search} placeholder="Venda/pedido, SKU, produto ou ID do Caso" maxLength={160}/></label>
          <label>Marketplace<select name="marketplace" defaultValue={filters.marketplace}><option value="">Todos</option><option value="mercado_livre">Mercado Livre</option><option value="shopee">Shopee</option></select></label>
          <label>Conta<select name="account" defaultValue={filters.account}><option value="">Todas</option>{accounts.filter(a => !filters.marketplace || a.marketplace === filters.marketplace).map(a => <option key={a.id} value={a.id}>{a.name || a.nickname || "Não informado"}</option>)}</select></label>
        </div>
        <div className="form-actions"><button className="primary" type="submit">Aplicar filtros</button><Link className="secondary" href={path} prefetch={false}>Limpar</Link></div>
      </form>
    </section>
    <section className="card">
      <div className={styles.summary}><span>{total ? from + 1 : 0}–{Math.min(from + rows.length, total)} de <strong>{total} {total === 1 ? "Caso" : "Casos"}</strong></span><span className="muted">Horários de Brasília</span></div>
      {counts.unknown > 0 && filters.tab === "all" && <p className={styles.notice}>{counts.unknown} {counts.unknown === 1 ? "Caso com situação desconhecida/incompleta" : "Casos com situação desconhecida/incompleta"}. Necessidade de ação não informada permanece desconhecida.</p>}
      <CaseGrid key={JSON.stringify(filters) + page} rows={rows.map(row => ({ ...row, items: caseSaleItems(row, products), deadlines: knownCaseDeadlines(row), group: caseGroup(row), groupLabel: labels[caseGroup(row)] }))}/>
      {!rows.length && <p className="muted">Nenhum Caso encontrado para estes filtros.</p>}
      <nav className={`form-actions ${styles.pagination}`} aria-label="Paginação">{page > 1 && <Link prefetch={false} className="secondary" href={href(filters, { page: String(page - 1) })}>← Anterior</Link>}<span>Página {page} de {pages}</span>{page < pages && <Link prefetch={false} className="secondary" href={href(filters, { page: String(page + 1) })}>Próxima →</Link>}</nav>
    </section>
  </section></main>;
}
