"use server";

import { revalidatePath } from "next/cache";
import { supabaseAdmin } from "@/lib/supabase-admin";

export async function saveIntegrationModeAction(formData: FormData) {
  const mode = String(formData.get("mode") || "tiny");
  const normalizedMode = mode === "marketplace" ? "MARKETPLACE_DIRETO" : "TINY";
  const supabase = supabaseAdmin();

  await supabase.from("settings").upsert([
    {
      key: "PRODUCT_SEND_TARGET",
      value: normalizedMode,
      description: "[INTEGRACOES] Destino de envio do produto: TINY ou MARKETPLACE_DIRETO"
    },
    {
      key: "CRIAR_PRODUTO_TINY_API",
      value: normalizedMode === "TINY",
      description: "[CONFIG_GERAL] Criar produto no Tiny via API"
    },
    {
      key: "ENVIAR_MARKETPLACE_AUTOMATICO",
      value: normalizedMode === "MARKETPLACE_DIRETO",
      description: "[CONFIG_GERAL] Enviar produto diretamente aos marketplaces"
    }
  ]);

  revalidatePath("/integracoes");
  revalidatePath("/configuracoes/config-geral");
}
