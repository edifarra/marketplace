"use server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

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
  revalidatePath("/configuracoes/categorias-marketplace");
  redirect("/configuracoes/categorias-marketplace?sucesso=Mapeamento+salvo+com+sucesso");
}
