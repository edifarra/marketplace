import { Sidebar } from "@/app/components/sidebar";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { saveSaleStatusMapping } from "./actions";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const INTERNAL_STATUSES = [
  ["aguardando_pagamento", "Aguardando pagamento"],
  ["pagamento_em_processamento", "Pagamento em processamento"],
  ["paga", "Paga"],
  ["pronta_para_envio", "Pronta para envio"],
  ["a_caminho", "A caminho"],
  ["saiu_para_entrega", "Saiu para entrega"],
  ["entregue", "Entregue"],
  ["concluida", "Concluída"],
  ["cancelada", "Cancelada"],
  ["reembolsada", "Reembolsada"],
  ["devolucao_solicitada", "Devolução solicitada"],
  ["cancelamento_solicitado", "Cancelamento solicitado"]
] as const;

type Props = { searchParams?: { marketplace?: string; sucesso?: string; erro?: string } };

export default async function SaleStatusMappingsPage({ searchParams }: Props) {
  const marketplace = searchParams?.marketplace || "";
  let query = supabaseAdmin().from("status_venda").select("*")
    .order("marketplace").order("external_status");
  if (marketplace) query = query.eq("marketplace", marketplace);
  const { data, error } = await query;

  return <main className="shell"><Sidebar /><section className="main">
    <div className="topbar"><div>
      <h1>De–Para de Status de Vendas</h1>
      <div className="subtitle">Defina como cada status e substatus recebido dos marketplaces aparece no sistema.</div>
    </div></div>

    {searchParams?.sucesso && <div className="message success">{searchParams.sucesso}</div>}
    {(searchParams?.erro || error) && <div className="message error">{searchParams?.erro || error?.message}</div>}

    <section className="section card">
      <div className="table-toolbar">
        <div><h2>Mapeamentos</h2><div className="muted">Novas combinações recebidas são incluídas automaticamente.</div></div>
        <form className="search-form">
          <select name="marketplace" defaultValue={marketplace}>
            <option value="">Todos os marketplaces</option>
            <option value="mercado_livre">Mercado Livre</option>
            <option value="shopee">Shopee</option>
          </select>
          <button className="secondary compact" type="submit">Filtrar</button>
        </form>
      </div>
      <table>
        <thead><tr>
          <th>Marketplace</th><th>Status externo</th><th>Substatus externo</th>
          <th>Status no sistema</th><th>Descrição exibida</th><th>Regras</th><th>Ação</th>
        </tr></thead>
        <tbody>
          {(data || []).map((row) => {
            const [externalStatus, externalSubstatus = "—"] = String(row.external_status).split("::");
            return <tr key={row.id}>
              <td>{row.marketplace === "mercado_livre" ? "Mercado Livre" : row.marketplace === "shopee" ? "Shopee" : row.marketplace}</td>
              <td><code>{externalStatus}</code></td>
              <td><code>{externalSubstatus}</code></td>
              <td colSpan={4}>
                <form action={saveSaleStatusMapping} className="inline-edit-form">
                  <input type="hidden" name="id" value={row.id} />
                  <select name="internal_status" defaultValue={canonicalStatus(row.internal_status)}>
                    {INTERNAL_STATUSES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                  <input name="description" defaultValue={row.description || ""} aria-label="Descrição exibida" required />
                  <label><input type="checkbox" name="reserves_stock" defaultChecked={row.reserves_stock} /> Reserva estoque</label>
                  <label><input type="checkbox" name="final_status" defaultChecked={row.final_status} /> Status final</label>
                  <button className="primary compact" type="submit">Salvar</button>
                </form>
              </td>
            </tr>;
          })}
        </tbody>
      </table>
    </section>
  </section></main>;
}

function canonicalStatus(value: string) {
  const aliases: Record<string, string> = {
    criada: "pronta_para_envio",
    nao_paga: "aguardando_pagamento",
    processada: "pronta_para_envio",
    enviada: "a_caminho"
  };
  const normalized = aliases[value] || value;
  return INTERNAL_STATUSES.some(([status]) => status === normalized) ? normalized : "paga";
}
