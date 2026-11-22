import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { Sidebar } from "@/app/components/sidebar";
import { saveFreteFlexCity, saveFreteFlexConfiguration, toggleFreteFlexCity } from "./actions";
import { DeleteCityButton } from "./delete-city-button";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Props = { searchParams?: Promise<{ sucesso?: string; erro?: string }> };

export default async function FreteFlexPage({ searchParams }: Props) {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=%2Fconfiguracoes%2Ffrete-flex");
  const params = (await searchParams) ?? {};
  const db = supabaseAdmin();
  const configuration = await db.from("config_frete_flex").select("id,custo_capital_grande_sp,custo_extremo_sp,percentual_gris,percentual_ad_valorem,peso_limite_kg,adicional_kg_acima_10,ativo").eq("chave", "padrao").maybeSingle();
  const cities = configuration.data
    ? await db.from("config_frete_flex_cidades_extremo").select("id,cidade,ativo,observacoes").eq("configuracao_id", configuration.data.id).order("cidade")
    : { data: null, error: configuration.error };
  const canEdit = user.isMaster;

  return <main className="shell"><Sidebar/><section className="main">
    <div className="topbar"><div><h1>Frete FLEX</h1><div className="subtitle">Configure os parâmetros da tarifa e as cidades que recebem o custo de Extremos SP.</div></div></div>
    {params.erro && <div className="form-error" role="alert">{params.erro}</div>}
    {params.sucesso && <div className="form-success" role="status">{params.sucesso}</div>}
    {configuration.error && <div className="form-error" role="alert">Não foi possível carregar a configuração do Frete FLEX.</div>}
    {!configuration.data && !configuration.error && <div className="form-error" role="alert">Configuração padrão do Frete FLEX não encontrada.</div>}
    {configuration.data && <section className="section card">
      <div className="table-toolbar"><div><h2>Parâmetros da tarifa</h2><div className="muted">Percentuais informados em porcentagem. Os valores são armazenados na configuração existente.</div></div></div>
      <form action={saveFreteFlexConfiguration} className="config-form">
        <div className="form-grid frete-flex-fields">
          <label>Custo Capital / Grande SP (R$)<input name="custo_capital_grande_sp" type="number" min="0" step="0.01" required defaultValue={configuration.data.custo_capital_grande_sp}/></label>
          <label>Custo Extremos SP (R$)<input name="custo_extremo_sp" type="number" min="0" step="0.01" required defaultValue={configuration.data.custo_extremo_sp}/></label>
          <label>GRIS (%)<input name="percentual_gris" type="number" min="0" max="100" step="0.0001" required defaultValue={configuration.data.percentual_gris}/></label>
          <label>Ad Valorem (%)<input name="percentual_ad_valorem" type="number" min="0" max="100" step="0.0001" required defaultValue={configuration.data.percentual_ad_valorem}/></label>
          <label>Limite de peso (kg)<input name="peso_limite_kg" type="number" min="0.001" step="0.01" required defaultValue={configuration.data.peso_limite_kg}/></label>
          <label>Quilo adicional (R$)<input name="adicional_kg_acima_10" type="number" min="0" step="0.01" required defaultValue={configuration.data.adicional_kg_acima_10}/></label>
        </div>
        {canEdit ? <div className="form-actions"><button className="primary" type="submit">Salvar parâmetros</button></div> : <p className="muted frete-flex-readonly">Somente o usuário Master pode alterar esta configuração.</p>}
      </form>
    </section>}

    <section className="section card">
      <div className="table-toolbar"><div><h2>Cidades de Extremo SP</h2><div className="muted">Cidades fora da lista ativa usam a tarifa Capital / Grande SP. {cities.data?.length ?? 0} cadastradas.</div></div></div>
      {cities.error && <div className="form-error" role="alert">Não foi possível carregar as cidades de Extremo SP.</div>}
      {canEdit && <form action={saveFreteFlexCity} className="frete-flex-new-city"><label htmlFor="frete-flex-new-city">Adicionar cidade<input id="frete-flex-new-city" name="cidade" maxLength={120} required placeholder="Ex.: Município (SP)"/></label><button className="primary" type="submit">Adicionar</button></form>}
      <div className="table-wrap"><table><thead><tr><th>Cidade</th><th>Tarifa aplicada</th><th>Status</th>{canEdit && <th>Ações</th>}</tr></thead><tbody>
        {(cities.data || []).map(city => <tr key={city.id}>
          <td>{canEdit ? <form action={saveFreteFlexCity} className="frete-flex-city-edit"><input type="hidden" name="id" value={city.id}/><input aria-label={`Nome da cidade ${city.cidade}`} name="cidade" maxLength={120} required defaultValue={city.cidade}/><button className="secondary compact" type="submit">Salvar nome</button></form> : city.cidade}</td>
          <td>{city.ativo ? "Extremos SP" : "Capital / Grande SP"}</td>
          <td>{canEdit ? <form action={toggleFreteFlexCity}><input type="hidden" name="id" value={city.id}/><input type="hidden" name="ativo" value={String(!city.ativo)}/><button className={city.ativo ? "secondary compact" : "primary compact"} type="submit">{city.ativo ? "Desativar" : "Ativar"}</button></form> : city.ativo ? "Ativa" : "Inativa"}</td>
          {canEdit && <td><DeleteCityButton id={city.id}/></td>}
        </tr>)}
        {!cities.data?.length && !cities.error && <tr><td colSpan={canEdit ? 4 : 3}>Nenhuma cidade cadastrada.</td></tr>}
      </tbody></table></div>
      {!canEdit && <p className="muted frete-flex-readonly">Somente o usuário Master pode incluir, editar, ativar ou excluir cidades.</p>}
    </section>
  </section></main>;
}
