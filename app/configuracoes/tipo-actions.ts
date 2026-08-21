"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { supabaseAdmin } from "@/lib/supabase-admin";
import type { MarketplaceValues } from "@/lib/marketplace-attributes";

export async function saveTypeConfiguration(formData: FormData) {
  const text = (key: string) => String(formData.get(key) || "").trim();
  const numeric = (key: string) => Number(text(key).replace(",", ".") || 0);
  const code = text("code").toUpperCase();
  const originalCode = text("originalCode");
  const marketplaceCategory = text("marketplace_category");
  if (!code || !text("description") || !text("sku_group") || !marketplaceCategory) {
    redirect(`/configuracoes/tipo?${originalCode ? `edit=${encodeURIComponent(originalCode)}&` : "novo=1&"}erro=${encodeURIComponent("Preencha Sigla, Descrição, Grupo SKU e Categoria Interna.")}`);
  }
  const defaults: MarketplaceValues = {};
  const activeAttributes: Partial<Record<"mercado_livre" | "shopee", string[]>> = { mercado_livre: [], shopee: [] };
  for (const [key, raw] of formData.entries()) {
    const activeMatch = key.match(/^activeAttribute\.(mercado_livre|shopee)\.([^\.]+)$/);
    if (activeMatch) {
      activeAttributes[activeMatch[1] as "mercado_livre" | "shopee"]!.push(activeMatch[2]);
      continue;
    }
    const match = key.match(/^attribute\.(mercado_livre|shopee)\.([^\.]+)\.(valueId|valueName|unit)$/);
    if (!match) continue;
    const [, marketplace, attributeId, property] = match;
    const value = String(raw || "").trim();
    const group = (defaults as any)[marketplace] ||= { categoryId: text(`${marketplace}_category_id`), attributes: {} };
    const attribute = group.attributes[attributeId] ||= {};
    if (value) attribute[property] = value;
  }
  const payload = {
    code, description: text("description"), sku_group: text("sku_group"), sku_max: numeric("sku_max") || null,
    warranty_months: numeric("warranty_months"), marketplace_category: marketplaceCategory, search_term: text("search_term") || null,
    weight_net: numeric("weight_net"), weight_gross: numeric("weight_gross"), width: numeric("width"), height: numeric("height"), length: numeric("length"),
    title_template: text("title_template"), description_template: text("description_template"), marketplace_attribute_defaults: defaults,
    marketplace_active_attributes: activeAttributes,
    updated_at: new Date().toISOString()
  };
  const db = supabaseAdmin();
  const result = originalCode
    ? await db.from("config_types").update(payload).eq("code", originalCode)
    : await db.from("config_types").insert(payload);
  if (result.error) redirect(`/configuracoes/tipo?${originalCode ? `edit=${encodeURIComponent(originalCode)}&` : "novo=1&"}erro=${encodeURIComponent(result.error.message)}`);
  revalidatePath("/configuracoes/tipo");
  redirect(`/configuracoes/tipo?sucesso=${encodeURIComponent(`Tipo ${originalCode ? "atualizado" : "criado"} com sucesso.`)}`);
}
