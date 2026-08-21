"use server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { syncCategoryAttributes } from "@/lib/marketplace-attributes";

export async function saveCategoryMapping(formData: FormData) {
  const internal = String(formData.get("internal_category") || "").trim();
  if (!internal) redirect("/configuracoes/categorias-marketplace?erro=Categoria+interna+obrigatoria");
  const value = (name: string) => String(formData.get(name) || "").trim() || null;
  await supabaseAdmin().from("marketplace_category_mappings").upsert({
    internal_category: internal,
    mercado_livre_code: value("mercado_livre_code"), mercado_livre_description: value("mercado_livre_description"),
    shopee_code: value("shopee_code"), shopee_description: value("shopee_description"),
    tiny_code: value("tiny_code"), tiny_description: value("tiny_description"), updated_at: new Date().toISOString()
  }, { onConflict: "internal_category" }).throwOnError();
  try {
    await syncCategoryAttributes(internal);
  } catch (error) {
    revalidatePath("/configuracoes/categorias-marketplace");
    redirect(`/configuracoes/categorias-marketplace?erro=${encodeURIComponent(`Mapeamento salvo, mas os atributos não foram atualizados: ${error instanceof Error ? error.message : String(error)}`)}`);
  }
  revalidatePath("/configuracoes/categorias-marketplace");
  redirect("/configuracoes/categorias-marketplace?sucesso=Mapeamento+salvo+com+sucesso");
}

export async function updateCategoryAttributes(formData: FormData) {
  const internal = String(formData.get("internal_category") || "").trim();
  if (!internal) redirect("/configuracoes/categorias-marketplace?erro=Categoria+interna+obrigatoria");
  try {
    const definitions = await syncCategoryAttributes(internal);
    const count = Object.values(definitions).reduce((total, group) => total + Object.keys(group?.attributes || {}).length, 0);
    revalidatePath("/configuracoes/categorias-marketplace");
    redirect(`/configuracoes/categorias-marketplace?sucesso=${encodeURIComponent(`${count} atributos atualizados para ${internal}.`)}`);
  } catch (error) {
    redirect(`/configuracoes/categorias-marketplace?erro=${encodeURIComponent(error instanceof Error ? error.message : String(error))}`);
  }
}

export async function renameCategoryMapping(formData: FormData) {
  const current = String(formData.get("current_internal_category") || "").trim();
  const next = String(formData.get("internal_category") || "").trim();
  if (!current || !next) redirect("/configuracoes/categorias-marketplace?erro=Informe+a+categoria+interna");
  if (current === next) redirect("/configuracoes/categorias-marketplace?erro=Informe+uma+nova+descricao");

  const db = supabaseAdmin();
  const existing = await db.from("marketplace_category_mappings").select("internal_category").eq("internal_category", next).maybeSingle();
  if (existing.error) redirect(`/configuracoes/categorias-marketplace?erro=${encodeURIComponent(existing.error.message)}`);
  if (existing.data) redirect("/configuracoes/categorias-marketplace?erro=Ja+existe+um+mapeamento+com+essa+categoria+interna");

  const result = await db.from("marketplace_category_mappings")
    .update({ internal_category: next, updated_at: new Date().toISOString() })
    .eq("internal_category", current)
    .select("internal_category")
    .maybeSingle();
  if (result.error) redirect(`/configuracoes/categorias-marketplace?erro=${encodeURIComponent(result.error.message)}`);
  if (!result.data) redirect("/configuracoes/categorias-marketplace?erro=Mapeamento+nao+encontrado");

  revalidatePath("/configuracoes/categorias-marketplace");
  redirect("/configuracoes/categorias-marketplace?sucesso=Descricao+da+categoria+interna+alterada");
}

export async function deleteCategoryMapping(formData: FormData) {
  const internal = String(formData.get("internal_category") || "").trim();
  if (!internal) redirect("/configuracoes/categorias-marketplace?erro=Categoria+interna+obrigatoria");

  const result = await supabaseAdmin().from("marketplace_category_mappings")
    .delete()
    .eq("internal_category", internal)
    .select("internal_category")
    .maybeSingle();
  if (result.error) redirect(`/configuracoes/categorias-marketplace?erro=${encodeURIComponent(result.error.message)}`);
  if (!result.data) redirect("/configuracoes/categorias-marketplace?erro=Mapeamento+nao+encontrado");

  revalidatePath("/configuracoes/categorias-marketplace");
  redirect("/configuracoes/categorias-marketplace?sucesso=Mapeamento+excluido+com+sucesso");
}
