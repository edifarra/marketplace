export function activityGroup(marketplace: string, eventType: string) {
  const type = String(eventType || "notification");
  if (marketplace === "shopee") {
    if (["3", "47"].includes(type)) return "Pedidos";
    if (["4", "30"].includes(type)) return "Envios";
    if (type === "29") return "Devoluções";
    if (type === "10") return "Atendimento";
    if (type === "22") return "Produtos e anúncios";
    if (["1", "2", "12"].includes(type)) return "Integração";
    return "Avisos da Shopee";
  }
  if (["orders_v2", "orders_feedback"].includes(type)) return "Pedidos";
  if (type === "shipments") return "Envios";
  if (["messages", "questions"].includes(type)) return "Atendimento";
  if (["public_candidates", "price_suggestion"].includes(type)) return "Promoções e preços";
  if (["items", "items_prices", "stock-locations", "user-products-families"].includes(type)) return "Produtos e anúncios";
  return "Outras notificações";
}

export function activityTypeLabel(marketplace: string, eventType: string) {
  const type = String(eventType || "notification");
  const shopee: Record<string, string> = {
    "1": "Autorização da loja", "2": "Desconexão da loja", "3": "Status do pedido",
    "4": "Código de rastreamento", "5": "Aviso da Shopee", "10": "Mensagem do comprador",
    "12": "Validade da autorização", "15": "Atualização do pedido", "22": "Alteração do produto",
    "29": "Devolução ou reembolso", "30": "Situação logística", "37": "Atualização do pedido",
    "47": "Dados do pedido"
  };
  const mercadoLivre: Record<string, string> = {
    orders_v2: "Atualização do pedido", shipments: "Atualização do envio",
    items: "Alteração do anúncio", items_prices: "Alteração de preço",
    "stock-locations": "Alteração de estoque", "user-products-families": "Alteração do catálogo",
    messages: "Mensagem do comprador", questions: "Pergunta no anúncio",
    orders_feedback: "Avaliação do pedido", public_candidates: "Oportunidade de promoção",
    price_suggestion: "Sugestão de preço", notification: "Notificação"
  };
  return (marketplace === "shopee" ? shopee[type] : mercadoLivre[type]) || `Notificação ${type}`;
}

export function activityDescription(marketplace: string, eventType: string, rawPayload: Record<string, any> | null | undefined) {
  const payload = rawPayload || {};
  const notification = (payload.notification || payload) as Record<string, any>;
  const data = notification.data || {};
  const type = String(eventType || notification.code || notification.topic || "notification");
  if (marketplace === "shopee") {
    if (type === "3") return data.status ? `Pedido atualizado para ${shopeeStatus(data.status)}.` : "Status do pedido atualizado.";
    if (type === "4") return data.tracking_no ? `Código de rastreamento informado: ${data.tracking_no}.` : "Código de rastreamento informado.";
    if (type === "29") return `Devolução ou reembolso atualizado${updatedValue(data, "return_status")}.`;
    if (type === "30") return data.fulfillment_status ? `Envio atualizado para ${logisticsStatus(data.fulfillment_status)}.` : "Situação logística atualizada.";
    if (type === "47") return changedFields(data.changed_fields);
    if (type === "22") return data.update_field ? `${productField(data.update_field)} do produto atualizado.` : "Dados do produto atualizados.";
    if (type === "10") return "Nova movimentação no atendimento ao comprador.";
    if (type === "5") return String(Array.isArray(data) ? data[0]?.title || "Aviso recebido da Shopee." : "Aviso recebido da Shopee.");
    return `${activityTypeLabel(marketplace, type)} recebida.`;
  }
  const resource = String(notification.resource || "");
  const resourceId = resource.split("/").filter(Boolean).pop();
  return `${activityTypeLabel(marketplace, type)}${resourceId ? ` — referência ${resourceId}` : ""}.`;
}

function changedFields(fields: unknown) {
  const labels: Record<string, string> = { ship_by_date: "prazo de envio", logistics_channel_id: "canal logístico", return_code: "devolução" };
  const translated = (Array.isArray(fields) ? fields : []).map((field) => labels[String(field)] || String(field).replaceAll("_", " "));
  return translated.length ? `Dados do pedido atualizados: ${translated.join(", ")}.` : "Dados do pedido atualizados.";
}

function updatedValue(data: Record<string, any>, field: string) {
  const row = (Array.isArray(data.updated_values) ? data.updated_values : []).find((item: Record<string, any>) => item.update_field === field);
  return row?.new_value ? ` para ${String(row.new_value).toLocaleLowerCase("pt-BR")}` : "";
}

function productField(field: string) {
  const labels: Record<string, string> = { original_price: "Preço", stock: "Estoque", item_status: "Status" };
  return labels[field] || "Informação";
}

function shopeeStatus(status: string) {
  const labels: Record<string, string> = {
    UNPAID: "pagamento pendente", READY_TO_SHIP: "pronto para envio", PROCESSED: "envio organizado",
    RETRY_SHIP: "nova tentativa de envio", SHIPPED: "enviado", TO_CONFIRM_RECEIVE: "aguardando confirmação de recebimento",
    IN_CANCEL: "cancelamento solicitado", CANCELLED: "cancelado", TO_RETURN: "devolução solicitada", COMPLETED: "concluído"
  };
  return labels[String(status).toUpperCase()] || String(status).replaceAll("_", " ").toLocaleLowerCase("pt-BR");
}

function logisticsStatus(status: string) {
  const labels: Record<string, string> = {
    LOGISTICS_NOT_START: "logística não iniciada", LOGISTICS_READY: "pronto para envio",
    LOGISTICS_REQUEST_CREATED: "coleta solicitada", LOGISTICS_PICKUP_PENDING: "aguardando coleta",
    LOGISTICS_PICKUP_RETRY: "nova tentativa de coleta", LOGISTICS_PICKUP_DONE: "pacote coletado",
    LOGISTICS_PICKUP_FAILED: "falha na coleta", LOGISTICS_PARCEL_RECEIVED: "recebido pela transportadora",
    LOGISTICS_TRANSPORTING: "em trânsito", LOGISTICS_DELIVERING: "saiu para entrega",
    LOGISTICS_DELIVERY_DONE: "entregue", LOGISTICS_DELIVERY_FAILED: "falha na entrega"
  };
  return labels[String(status).toUpperCase()] || String(status).replaceAll("_", " ").toLocaleLowerCase("pt-BR");
}
