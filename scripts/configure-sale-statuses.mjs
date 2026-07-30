import nextEnv from "@next/env";
import { createClient } from "@supabase/supabase-js";

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

const ml = (external_status, internal_status, description, reserves_stock = false, final_status = false) => ({
  marketplace: "mercado_livre", external_status, internal_status, description, reserves_stock, final_status
});
const shopee = (external_status, internal_status, description, reserves_stock = false, final_status = false) => ({
  marketplace: "shopee", external_status, internal_status, description, reserves_stock, final_status
});

const mappings = [
  ml("confirmed", "aguardando_pagamento", "Venda confirmada, aguardando pagamento"),
  ml("payment_required", "aguardando_pagamento", "Pagamento pendente"),
  ml("payment_in_process", "pagamento_em_processamento", "Pagamento em processamento"),
  ml("partially_paid", "pagamento_em_processamento", "Pagamento parcial"),
  ml("paid", "paga", "Venda paga", true),
  ml("partially_refunded", "reembolsada", "Venda parcialmente reembolsada"),
  ml("pending_cancel", "cancelamento_solicitado", "Cancelamento pendente"),
  ml("cancelled", "cancelada", "Venda cancelada", false, true),
  ml("invalid", "cancelada", "Venda invalidada", false, true),
  ml("refunded", "reembolsada", "Venda reembolsada", false, true),
  ml("to_be_agreed", "pronta_para_envio", "Entrega a combinar", true),
  ml("pending", "pronta_para_envio", "Envio pendente de liberação", true),
  ml("pending::buffered", "pronta_para_envio", "Envio programado para uma data futura", true),
  ml("pending::creating_route", "pronta_para_envio", "Rota de envio em criação", true),
  ml("pending::cost_exceeded", "pronta_para_envio", "Custo do envio excedido", true),
  ml("pending::under_review", "pronta_para_envio", "Envio em análise", true),
  ml("handling", "pronta_para_envio", "Pedido em preparação", true),
  ml("handling::waiting_for_label_generation", "pronta_para_envio", "Aguardando geração da etiqueta", true),
  ml("ready_to_ship", "pronta_para_envio", "Pronto para envio", true),
  ml("ready_to_ship::invoice_pending", "pronta_para_envio", "NF-e, DC-e ou CT-e pendente", true),
  ml("ready_to_ship::ready_to_print", "pronta_para_envio", "Etiqueta pronta para impressão", true),
  ml("ready_to_ship::printed", "pronta_para_envio", "Etiqueta gerada ou impressa", true),
  ml("ready_to_ship::in_pickup_list", "pronta_para_envio", "Incluído em uma lista de coleta", true),
  ml("ready_to_ship::ready_for_pkl_creation", "pronta_para_envio", "Aguardando criação da lista de coleta", true),
  ml("ready_to_ship::ready_for_pickup", "pronta_para_envio", "Pronto para coleta", true),
  ml("ready_to_ship::picked_up", "a_caminho", "Coletado pela transportadora"),
  ml("ready_to_ship::authorized_by_carrier", "a_caminho", "Autorizado pela transportadora"),
  ml("ready_to_ship::in_hub", "a_caminho", "Recebido no centro de distribuição"),
  ml("ready_to_ship::in_packing_list", "a_caminho", "Em processamento no centro de distribuição"),
  ml("shipped", "a_caminho", "Pacote enviado"),
  ml("shipped::out_for_delivery", "saiu_para_entrega", "Saiu para entrega ao comprador"),
  ml("shipped::waiting_for_withdrawal", "a_caminho", "Aguardando retirada pelo comprador"),
  ml("shipped::receiver_absent", "a_caminho", "Tentativa de entrega: destinatário ausente"),
  ml("shipped::dangerous_area", "a_caminho", "Tentativa de entrega: região perigosa"),
  ml("shipped::bad_address", "a_caminho", "Tentativa de entrega: endereço incorreto"),
  ml("shipped::unauthorized_receiver", "a_caminho", "Tentativa de entrega: recebedor não autorizado"),
  ml("not_delivered", "devolucao_solicitada", "Entrega não realizada"),
  ml("not_delivered::returning_to_sender", "devolucao_solicitada", "Em devolução ao vendedor"),
  ml("delivered", "entregue", "Entregue ao comprador", false, true),
  ml("delivered::address_mismatch", "entregue", "Entregue em endereço divergente", false, true),
  ml("cancelled::closed_by_user", "cancelada", "Envio cancelado pelo usuário", false, true),

  shopee("UNPAID", "aguardando_pagamento", "Pagamento pendente"),
  shopee("READY_TO_SHIP", "pronta_para_envio", "Pronta para envio", true),
  shopee("PROCESSED", "pronta_para_envio", "Envio organizado e pronto para etiqueta", true),
  shopee("SHIPPED", "a_caminho", "Pedido enviado"),
  shopee("TO_CONFIRM_RECEIVE", "a_caminho", "Aguardando confirmação de recebimento"),
  shopee("COMPLETED", "concluida", "Pedido concluído", false, true),
  shopee("IN_CANCEL", "cancelamento_solicitado", "Cancelamento solicitado"),
  shopee("CANCELLED", "cancelada", "Pedido cancelado", false, true),
  shopee("TO_RETURN", "devolucao_solicitada", "Devolução solicitada"),
  shopee("INVOICE_PENDING", "pronta_para_envio", "Documento fiscal pendente", true)
];

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!url || !key) throw new Error("Supabase não configurado.");

const supabase = createClient(url, key, { auth: { persistSession: false } });
const { error } = await supabase.from("status_venda").upsert(mappings, {
  onConflict: "marketplace,external_status"
});
if (error) throw error;
console.log(`${mappings.length} mapeamentos de status configurados.`);
