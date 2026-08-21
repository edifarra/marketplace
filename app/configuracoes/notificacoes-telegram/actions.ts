"use server";

import { redirect } from "next/navigation";
import { requireMaster } from "@/lib/auth";
import { saveTelegramConfig, testTelegram } from "@/lib/telegram-notifications";

export async function saveTelegramAction(formData: FormData) {
  const user = await requireMaster();
  if (!user) redirect("/acesso-negado");
  try {
    await saveTelegramConfig({
      enabled: formData.get("enabled") === "on", botToken: formData.get("botToken"), chatId: formData.get("chatId"), recipientName: formData.get("recipientName"), timezone: formData.get("timezone"),
      newSaleEnabled: formData.get("newSaleEnabled") === "on", newSaleStart: formData.get("newSaleStart"), newSaleEnd: formData.get("newSaleEnd"),
      dispatchEnabled: formData.get("dispatchEnabled") === "on", dispatchCheckTime: formData.get("dispatchCheckTime")
    }, user.id);
    redirect("/configuracoes/notificacoes-telegram?sucesso=Configurações salvas com sucesso");
  } catch (error) {
    if (isRedirectError(error)) throw error;
    redirect(`/configuracoes/notificacoes-telegram?erro=${encodeURIComponent(error instanceof Error ? error.message : String(error))}`);
  }
}

export async function testTelegramAction() {
  if (!(await requireMaster())) redirect("/acesso-negado");
  try { await testTelegram(); redirect("/configuracoes/notificacoes-telegram?sucesso=Teste enviado com sucesso"); }
  catch (error) {
    if (isRedirectError(error)) throw error;
    redirect(`/configuracoes/notificacoes-telegram?erro=${encodeURIComponent(error instanceof Error ? error.message : String(error))}`);
  }
}

function isRedirectError(error: unknown) {
  return error instanceof Error
    && ("digest" in error ? String(error.digest).startsWith("NEXT_REDIRECT") : error.message === "NEXT_REDIRECT");
}
