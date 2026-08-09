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
  const marketplace = String(formData.get("marketplace") || "mercado_livre");
  if (!id || !ALLOWED_INTERNAL_STATUSES.has(internalStatus) || !description) {
    redirect(`/configuracoes/status-vendas?marketplace=${encodeURIComponent(marketplace)}&erro=Preencha+um+status+interno+e+uma+descricao+validos`);
  }

  const payload = {
    internal_status: internalStatus,
    description,
    reserves_stock: formData.get("reserves_stock") === "on",
    deducts_physical_stock: formData.get("deducts_physical_stock") === "on",
    releases_stock: formData.get("releases_stock") === "on",
    final_status: formData.get("final_status") === "on"
  };
  const db = supabaseAdmin();
  const { data: mapping, error: mappingError } = await db.from("status_venda")
    .select("marketplace,external_status").eq("id", id).single();
  if (mappingError) redirect(`/configuracoes/status-vendas?marketplace=${encodeURIComponent(marketplace)}&erro=${encodeURIComponent(mappingError.message)}`);

  const { error } = await db.from("status_venda").update(payload).eq("id", id);
  if (error) redirect(`/configuracoes/status-vendas?marketplace=${encodeURIComponent(marketplace)}&erro=${encodeURIComponent(error.message)}`);
  if (formData.get("apply_to_substatuses") === "on" && !mapping.external_status.includes("::")) {
    const cascade = await db.from("status_venda").update(payload)
      .eq("marketplace", mapping.marketplace)
      .like("external_status", `${mapping.external_status}::%`);
    if (cascade.error) redirect(`/configuracoes/status-vendas?marketplace=${encodeURIComponent(marketplace)}&erro=${encodeURIComponent(cascade.error.message)}`);
  }

  revalidatePath("/configuracoes/status-vendas");
  revalidatePath("/vendas");
  revalidatePath("/");
  redirect(`/configuracoes/status-vendas?marketplace=${encodeURIComponent(marketplace)}&sucesso=Mapeamento+salvo`);
}
