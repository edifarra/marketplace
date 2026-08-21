import { Sidebar } from "@/app/components/sidebar";

export const dynamic = "force-dynamic";

export default function ReportsPage() {
  return <main className="shell"><Sidebar /><section className="main">
    <div className="topbar"><div><h1>Relatórios</h1><div className="subtitle">Extrações dos dados consolidados do sistema.</div></div></div>
    <section className="card"><div className="table-wrap"><table>
      <thead><tr><th>Relatório</th><th>Descrição</th><th>Ação</th></tr></thead>
      <tbody><tr>
        <td><strong>Relatório de Produtos e Estoques</strong></td>
        <td>Extração de todos os produtos no sistema e seus respectivos estoques físicos e disponíveis.</td>
        <td><a className="primary compact" href="/api/relatorios/produtos-estoques">Extrair</a></td>
      </tr></tbody>
    </table></div></section>
  </section></main>;
}
