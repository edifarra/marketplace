import { Sidebar } from "@/app/components/sidebar";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { StatusMappingsTable } from "./status-mappings-table";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Props = { searchParams?: { marketplace?: string; sucesso?: string; erro?: string } };

const MARKETPLACES = [
  ["mercado_livre", "Mercado Livre"],
  ["shopee", "Shopee"]
] as const;

export default async function SaleStatusMappingsPage({ searchParams }: Props) {
  const requestedMarketplace = String(searchParams?.marketplace || "mercado_livre");
  const marketplace = MARKETPLACES.some(([value]) => value === requestedMarketplace)
    ? requestedMarketplace
    : "mercado_livre";
  const { data, error } = await supabaseAdmin().from("status_venda").select("*")
    .eq("marketplace", marketplace).order("external_status");

  return <main className="shell"><Sidebar /><section className="main">
    <div className="topbar"><div>
      <h1>De–Para de Status de Vendas</h1>
      <div className="subtitle">Configure os status de cada marketplace e abra somente os substatus que precisar revisar.</div>
    </div></div>

    {searchParams?.sucesso && <div className="message success">{searchParams.sucesso}</div>}
    {(searchParams?.erro || error) && <div className="message error">{searchParams?.erro || error?.message}</div>}

    <section className="section card">
      <div className="status-marketplace-picker">
        <div>
          <label htmlFor="marketplace-status-filter">Marketplace</label>
          <div className="muted">Selecione a integração cujos status deseja configurar.</div>
        </div>
        <form className="search-form">
          <select id="marketplace-status-filter" name="marketplace" defaultValue={marketplace}>
            {MARKETPLACES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <button className="primary compact" type="submit">Selecionar</button>
        </form>
      </div>
    </section>

    <section className="section card">
      <div className="table-toolbar">
        <div>
          <h2>Status de {MARKETPLACES.find(([value]) => value === marketplace)?.[1]}</h2>
          <div className="muted">Clique em um status para mostrar ou ocultar seus substatus.</div>
        </div>
      </div>
      <StatusMappingsTable rows={data || []} marketplace={marketplace} />
    </section>
  </section></main>;
}
