export interface ConversationRow {
  [key: string]: any;
  id: string;
  messages: Array<Record<string, any>>;
  slaHours: number;
  slaBreached: boolean;
  groupKey: string;
  grouped_conversation_ids: string[];
}

export type ConversationView = {
  tab: "today" | "all";
  marketplace: string;
  store: string;
  status: string;
  sla: string;
  search: string;
  from: string;
  to: string;
  unread: string;
};

export function prepareConversationRows(
  rows: Array<Record<string, any>>,
  withProductHours: number,
  withoutProductHours: number,
  now = Date.now()
) {
  const individualRows = rows.map((row) => {
    const slaHours = row.product_id || row.listing_id ? withProductHours : withoutProductHours;
    const since = new Date(row.last_incoming_at || row.last_message_at).getTime();
    return {
      ...row,
      messages: [...(row.marketplace_conversation_messages || row.messages || [])].sort(compareConversationMessages),
      slaHours,
      slaBreached: Boolean(row.requires_response) && now - since >= slaHours * 3600000
    };
  });
  return groupMercadoLivreQuestions(individualRows);
}

export function conversationGroupKey(row: Record<string, any>) {
  return row.marketplace === "mercado_livre" && row.conversation_type === "question"
    ? `ml:${row.marketplace_account_id}:${row.buyer_id || row.buyer_name}:${row.sku || row.listing_id}`
    : `single:${row.id}`;
}

export function groupMercadoLivreQuestions(rows: Array<Record<string, any>>): ConversationRow[] {
  const groups = new Map<string, Array<Record<string, any>>>();
  for (const row of rows) {
    const key = conversationGroupKey(row);
    groups.set(key, [...(groups.get(key) || []), row]);
  }
  return [...groups.entries()].map(([groupKey, members]) => {
    if (members.length === 1) {
      return {
        ...members[0],
        groupKey,
        grouped_conversation_ids: [String(members[0].id)],
        question_count: members[0].conversation_type === "question" ? 1 : undefined
      } as unknown as ConversationRow;
    }
    members.sort((a, b) => new Date(a.last_message_at).getTime() - new Date(b.last_message_at).getTime());
    const actionable = [...members].reverse().find((row) => row.requires_response) || members[members.length - 1];
    const pending = members.filter((row) => row.requires_response);
    const messages = members.flatMap((row) => row.messages).sort(compareConversationMessages);
    const firstValue = (field: string) => [...members].reverse().find((row) => row[field] != null)?.[field] ?? null;
    const lastIncoming = pending.length
      ? pending.reduce((latest, row) => new Date(row.last_incoming_at) > new Date(latest) ? row.last_incoming_at : latest, pending[0].last_incoming_at)
      : firstValue("last_incoming_at");
    return {
      ...actionable,
      groupKey,
      question_count: members.length,
      grouped_conversation_ids: members.map((row) => String(row.id)),
      grouped_external_ids: members.map((row) => row.external_conversation_id),
      messages,
      requires_response: pending.length > 0,
      unread: pending.some((row) => row.unread),
      status: pending.length ? "pending" : "answered",
      last_incoming_at: lastIncoming,
      last_outgoing_at: firstValue("last_outgoing_at"),
      last_message_at: firstValue("last_message_at"),
      updated_at: firstValue("updated_at"),
      sku: firstValue("sku"),
      product_id: firstValue("product_id"),
      product_title: firstValue("product_title"),
      product_price: firstValue("product_price"),
      product_image_url: firstValue("product_image_url"),
      available_stock: firstValue("available_stock"),
      item_permalink: firstValue("item_permalink"),
      slaBreached: pending.some((row) => row.slaBreached)
    } as unknown as ConversationRow;
  });
}

export function compareConversationMessages(a: Record<string, any>, b: Record<string, any>) {
  const byDate = new Date(a.sent_at).getTime() - new Date(b.sent_at).getTime();
  if (byDate) return byDate;
  const left = BigInt(String(a.raw_data?.message_id || a.external_message_id || "0").replace(/\D/g, "") || "0");
  const right = BigInt(String(b.raw_data?.message_id || b.external_message_id || "0").replace(/\D/g, "") || "0");
  return left < right ? -1 : left > right ? 1 : 0;
}

export function conversationTimelineSections(row: Record<string, any>) {
  const messages = row.messages || [];
  if (row.conversation_type === "post_sale") return { before: [], after: messages, purchase: null, postSaleOnly: true };
  const purchase = row.purchased_at ? new Date(row.purchased_at).getTime() : null;
  return {
    before: purchase ? messages.filter((message: Record<string, any>) => new Date(message.sent_at).getTime() < purchase) : messages,
    after: purchase ? messages.filter((message: Record<string, any>) => new Date(message.sent_at).getTime() >= purchase) : [],
    purchase,
    postSaleOnly: false
  };
}

export function rowMatchesConversationView(row: ConversationRow, view: ConversationView, now = Date.now()) {
  const search = view.search.toLocaleUpperCase("pt-BR");
  const attendingSince = now - 24 * 60 * 60 * 1000;
  return (view.tab === "all" || new Date(row.last_message_at).getTime() >= attendingSince)
    && (!view.marketplace || row.marketplace === view.marketplace)
    && (!view.store || row.marketplace_account_id === view.store)
    && (!view.status || row.status === view.status)
    && (!view.sla || (view.sla === "outside" ? row.slaBreached : row.requires_response && !row.slaBreached))
    && (!view.unread || row.unread)
    && (!view.from || String(row.last_message_at) >= `${view.from}T00:00:00`)
    && (!view.to || String(row.last_message_at) <= `${view.to}T23:59:59.999`)
    && (!search || [row.sku, row.product_title, row.buyer_name, row.buyer_id, row.order_id, row.listing_id]
      .some((value) => String(value || "").toLocaleUpperCase("pt-BR").includes(search)));
}

export function sortConversationRows(a: ConversationRow, b: ConversationRow) {
  return new Date(b.last_message_at || 0).getTime() - new Date(a.last_message_at || 0).getTime();
}
