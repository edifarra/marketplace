"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { supabaseAdmin } from "@/lib/supabase-admin";

const ALLOWED_INTERNAL_STATUSES = new Set([
  "aguardando_pagamento",
  "pagamento_em_processamento",
  "paga",
  "pronta_para_envio",
  "a_caminho",
  "saiu_para_entrega",
  "entregue",
  "concluida",
  "cancelada",
  "reembolsada",
  "devolucao_solicitada",
  "cancelamento_solicitado"
]);

export async function saveSaleStatusMapping(formData: FormData) {
  const id = String(formData.get("id") || "");
  const internalStatus = String(formData.get("internal_status") || "");
  const description = String(formData.get("description") || "").trim();
  if (!id || !ALLOWED_INTERNAL_STATUSES.has(internalStatus) || !description) {
    redirect("/configuracoes/status-vendas?erro=Preencha+um+status+interno+e+uma+descricao+validos");
  }

  const { error } = await supabaseAdmin().from("status_venda").update({
    internal_status: internalStatus,
    description,
    reserves_stock: formData.get("reserves_stock") === "on",
    final_status: formData.get("final_status") === "on"
  }).eq("id", id);
  if (error) redirect(`/configuracoes/status-vendas?erro=${encodeURIComponent(error.message)}`);

  revalidatePath("/configuracoes/status-vendas");
  revalidatePath("/vendas");
  revalidatePath("/");
  redirect("/configuracoes/status-vendas?sucesso=Mapeamento+salvo");
}
