"use server";

import { revalidatePath } from "next/cache";
import { refreshMarketplaceAccountToken } from "@/lib/marketplace-token-refresh";
import { logMarketplaceAccountEvent } from "@/lib/marketplace-account-logs";
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

export async function syncMarketplaceAccountAction(formData: FormData) {
  const accountId = String(formData.get("accountId") || "");
  if (!accountId) {
    return;
  }

  try {
    await refreshMarketplaceAccountToken(accountId);
    await supabaseAdmin()
      .from("config_marketplace_accounts")
      .update({ last_sync_at: new Date().toISOString(), status: "active", last_error: null })
      .eq("id", accountId);
    await logMarketplaceAccountEvent("info", "Sincronizacao de conta finalizada", { accountId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await supabaseAdmin()
      .from("config_marketplace_accounts")
      .update({ status: "error", last_error: message })
      .eq("id", accountId);
    await logMarketplaceAccountEvent("error", "Erro na sincronizacao de conta", { accountId, error: message });
  }

  revalidatePath("/integracoes");
  revalidatePath("/configuracoes/marketplace");
}

export async function removeMarketplaceAccountAction(formData: FormData) {
  const accountId = String(formData.get("accountId") || "");
  if (!accountId) {
    return;
  }

  const supabase = supabaseAdmin();
  await supabase.from("product_marketplaces").delete().eq("marketplace_account_id", accountId);
  await supabase.from("listings").delete().eq("marketplace_account_id", accountId);
  await supabase.from("config_marketplace_accounts").delete().eq("id", accountId);
  await logMarketplaceAccountEvent("warn", "Conta marketplace removida", { accountId });

  revalidatePath("/integracoes");
  revalidatePath("/configuracoes/marketplace");
}
