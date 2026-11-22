"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireMaster } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { normalizeFreteFlexCity, normalizeFreteFlexCityKey, parseFreteFlexValues } from "@/lib/frete-flex-validation";

const PAGE = "/configuracoes/frete-flex";

export async function saveFreteFlexConfiguration(formData: FormData): Promise<never> {
  if (!(await requireMaster())) redirect("/acesso-negado");
  const parsed = parseFreteFlexValues(Object.fromEntries(formData.entries()));
  if (!parsed.data) return redirectWith("erro", parsed.error || "Revise os valores informados.");

  const { error } = await supabaseAdmin().from("config_frete_flex").update({
    custo_capital_grande_sp: parsed.data.custo_capital_grande_sp,
    custo_extremo_sp: parsed.data.custo_extremo_sp,
    percentual_gris: parsed.data.percentual_gris,
    percentual_ad_valorem: parsed.data.percentual_ad_valorem,
    peso_limite_kg: parsed.data.peso_limite_kg,
    adicional_kg_acima_10: parsed.data.adicional_kg_acima_10,
    atualizado_em: new Date().toISOString()
  }).eq("chave", "padrao");
  if (error) return redirectWith("erro", "Não foi possível salvar a configuração do Frete FLEX.");
  revalidatePath(PAGE);
  redirectWith("sucesso", "Configuração do Frete FLEX salva.");
}

export async function saveFreteFlexCity(formData: FormData): Promise<never> {
  if (!(await requireMaster())) redirect("/acesso-negado");
  const id = String(formData.get("id") || "").trim();
  const cidade = normalizeFreteFlexCity(formData.get("cidade"));
  if (!cidade || cidade.length > 120) return redirectWith("erro", "Informe uma cidade com até 120 caracteres.");
  const db = supabaseAdmin();
  const configId = await getConfigurationId(db);
  const cityKey = normalizeFreteFlexCityKey(cidade);
  let duplicateQuery = db.from("config_frete_flex_cidades_extremo")
    .select("id").eq("configuracao_id", configId).eq("cidade_normalizada", cityKey).limit(1);
  if (id) duplicateQuery = duplicateQuery.neq("id", id);
  const { data: duplicate, error: duplicateError } = await duplicateQuery.maybeSingle();
  if (duplicateError) return redirectWith("erro", "Não foi possível validar a cidade.");
  if (duplicate) return redirectWith("erro", "Essa cidade já está cadastrada.");

  const result = id
    ? await db.from("config_frete_flex_cidades_extremo").update({ cidade, atualizado_em: new Date().toISOString() })
      .eq("id", id).eq("configuracao_id", configId).select("id").maybeSingle()
    : await db.from("config_frete_flex_cidades_extremo").insert({ configuracao_id: configId, cidade, ativo: true }).select("id").maybeSingle();
  if (result.error) return redirectWith("erro", "Não foi possível salvar a cidade.");
  if (!result.data) return redirectWith("erro", "Cidade não encontrada para edição.");
  revalidatePath(PAGE);
  redirectWith("sucesso", id ? "Cidade atualizada." : "Cidade incluída como Extremo SP.");
}

export async function toggleFreteFlexCity(formData: FormData): Promise<never> {
  if (!(await requireMaster())) redirect("/acesso-negado");
  const id = String(formData.get("id") || "").trim();
  const active = formData.get("ativo") === "true";
  if (!id) return redirectWith("erro", "Cidade inválida.");
  const db = supabaseAdmin();
  const configId = await getConfigurationId(db);
  const { data, error } = await db.from("config_frete_flex_cidades_extremo")
    .update({ ativo: active, atualizado_em: new Date().toISOString() })
    .eq("id", id).eq("configuracao_id", configId).select("id").maybeSingle();
  if (error) return redirectWith("erro", "Não foi possível atualizar o status da cidade.");
  if (!data) return redirectWith("erro", "Cidade não encontrada.");
  revalidatePath(PAGE);
  redirectWith("sucesso", active ? "Cidade ativada como Extremo SP." : "Cidade desativada; será usada a tarifa Capital / Grande SP.");
}

export async function deleteFreteFlexCity(formData: FormData): Promise<never> {
  if (!(await requireMaster())) redirect("/acesso-negado");
  const id = String(formData.get("id") || "").trim();
  if (!id) return redirectWith("erro", "Cidade inválida.");
  const db = supabaseAdmin();
  const configId = await getConfigurationId(db);
  const { data, error } = await db.from("config_frete_flex_cidades_extremo")
    .delete().eq("id", id).eq("configuracao_id", configId).select("id").maybeSingle();
  if (error) return redirectWith("erro", "Não foi possível excluir a cidade.");
  if (!data) return redirectWith("erro", "Cidade não encontrada.");
  revalidatePath(PAGE);
  redirectWith("sucesso", "Cidade excluída. As demais cidades usam a tarifa Capital / Grande SP.");
}

function redirectWith(kind: "erro" | "sucesso", message: string): never {
  redirect(`${PAGE}?${kind}=${encodeURIComponent(message)}`);
}

async function getConfigurationId(db: ReturnType<typeof supabaseAdmin>) {
  const { data, error } = await db.from("config_frete_flex").select("id").eq("chave", "padrao").single();
  if (error || !data) return redirectWith("erro", "Configuração padrão do Frete FLEX não encontrada.");
  return data.id;
}
