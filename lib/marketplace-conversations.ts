import { createHash } from "crypto";
import { revalidatePath } from "next/cache";
import { getCurrentUser } from "./auth";
import {
  answerMercadoLivreQuestion,
  getActiveMercadoLivreAccounts,
  getMercadoLivreAccountById,
  getMercadoLivreResource,
  sendMercadoLivrePostSaleMessage
} from "./mercado-livre";
import { getActiveShopeeAccounts, getValidShopeeAccessToken, ShopeeAccountConfig } from "./shopee";
import { createShopeeClient, getShopeeOAuthConfig } from "./shopee-oauth";
import { enqueueOutgoingActivity, processOutgoingActivities } from "./outgoing-activities";
import { supabaseAdmin } from "./supabase-admin";

type Account = { id: string; name: string; marketplace: string; seller_id?: string | null; account_id?: string | null; shop_id?: string | null };

export async function syncAllMarketplaceConversations() {
  const results: Array<Record<string, unknown>> = [];
  for (const account of await getActiveMercadoLivreAccounts()) {
    try {
      const sellerId = account.seller_id || account.account_id;
      if (!sellerId) continue;
      const payload = await getMercadoLivreResource(`/questions/search?seller_id=${encodeURIComponent(sellerId)}&api_version=4&limit=50&sort_fields=date_created&sort_types=DESC`, account);
      for (const question of payload.questions || []) await persistMercadoLivreQuestion(question, account);
      results.push({ account: account.name, marketplace: "mercado_livre", count: (payload.questions || []).length, ok: true });
    } catch (error) {
      results.push({ account: account.name, marketplace: "mercado_livre", ok: false, error: safeError(error) });
    }
  }
  for (const account of await getActiveShopeeAccounts()) {
    try {
      const count = await syncShopeeConversationList(account);
      results.push({ account: account.name, marketplace: "shopee", count, ok: true });
    } catch (error) {
      results.push({ account: account.name, marketplace: "shopee", ok: false, error: safeError(error) });
    }
  }
  return results;
}

export async function processMercadoLivreConversationNotification(activity: Record<string, any>, payload: Record<string, any>) {
  const account = await findMercadoLivreAccount(payload.user_id);
  const resource = String(payload.resource || "");
  if (String(payload.topic) === "questions") {
    const question = await getMercadoLivreResource(`${resource}${resource.includes("?") ? "&" : "?"}api_version=4`, account as any);
    const conversation = await persistMercadoLivreQuestion(question, account);
    return { description: question.answer ? "Pergunta respondida." : isClosedQuestion(question.status) ? "Pergunta encerrada." : "Nova pergunta.", conversationId: conversation.id };
  }
  if (String(payload.topic) === "messages") {
    const remote = resource ? await getMercadoLivreResource(resource, account as any) : payload;
    const conversation = await persistMercadoLivrePostSale(remote, account, resource);
    return { description: "Nova mensagem.", conversationId: conversation.id };
  }
  return null;
}

export async function processShopeeConversationNotification(payload: Record<string, any>) {
  const shopId = String(payload.shop_id || payload.data?.shop_id || "");
  const accounts = await getActiveShopeeAccounts();
  const account = accounts.find(item => String(item.shop_id || item.account_id || "") === shopId);
  if (!account) throw new Error(`Conta Shopee ${shopId || "não informada"} não encontrada.`);
  const conversationId = String(payload.data?.conversation_id || payload.data?.conversationid || payload.conversation_id || "");
  if (conversationId) {
    await syncShopeeConversation(account, conversationId, payload);
    return { description: "Conversa atualizada.", conversationId };
  }
  const count = await syncShopeeConversationList(account);
  return { description: count ? "Nova mensagem." : "Conversa atualizada.", count };
}

export async function queueConversationReply(conversationId: string, text: string) {
  const user = await getCurrentUser();
  if (!user) throw new Error("Sessão expirada.");
  const cleanText = text.trim();
  const validation = validateMarketplaceReply(cleanText);
  if (validation.blocked.length) throw new Error(validation.blocked.join(" "));
  const db = supabaseAdmin();
  const conversationResult = await db.from("marketplace_conversations").select("*").eq("id", conversationId).single().throwOnError();
  const conversation = conversationResult.data;
  if (!conversation.requires_response && conversation.conversation_type === "question") throw new Error("Esta pergunta não está mais disponível para resposta.");
  const activityType = conversation.conversation_type === "question" ? "question_answer" : "answer_send";
  const draftId = `draft:${createHash("sha256").update(`${conversationId}:${cleanText}`).digest("hex")}`;
  await db.from("marketplace_conversation_messages").upsert({
    conversation_id: conversationId, external_message_id: draftId, direction: "outgoing", message_type: "text", text: cleanText,
    sender_id: user.id, sender_name: user.name, sent_at: new Date().toISOString(), status: "queued", raw_data: { operator_id: user.id }
  }, { onConflict: "conversation_id,external_message_id" }).throwOnError();
  const activityId = await enqueueOutgoingActivity({
    destination: conversation.marketplace,
    activityType,
    productId: conversation.product_id,
    sku: conversation.sku || conversation.external_conversation_id,
    productName: conversation.product_title || (conversation.conversation_type === "question" ? "Pergunta" : "Conversa"),
    accountId: conversation.marketplace_account_id,
    listingId: conversation.listing_id,
    requestedData: { conversationId, text: cleanText, draftId, operatorId: user.id, operatorName: user.name },
    sourceType: "marketplace_conversation",
    sourceId: conversationId
  });
  await db.from("marketplace_conversations").update({ last_error: null, updated_at: new Date().toISOString() }).eq("id", conversationId).throwOnError();
  await processOutgoingActivities(10);
  revalidatePath("/chats-perguntas");
  revalidatePath("/atividades-marketplace/enviadas");
  return activityId;
}

export async function executeConversationReply(activity: Record<string, any>) {
  const requested = activity.requested_data || {};
  const conversationId = String(requested.conversationId || activity.source_id || "");
  const db = supabaseAdmin();
  const conversationResult = await db.from("marketplace_conversations").select("*").eq("id", conversationId).single().throwOnError();
  const conversation = conversationResult.data;
  const text = String(requested.text || "").trim();
  let remote: Record<string, any>;
  if (conversation.marketplace === "mercado_livre") {
    const account = await getMercadoLivreAccountById(conversation.marketplace_account_id);
    if (conversation.conversation_type === "question") {
      const alreadyAnswered = await reconcileAnsweredMercadoLivreQuestion(conversation, account, requested.draftId);
      if (alreadyAnswered) return alreadyAnswered;
      try {
        remote = await answerMercadoLivreQuestion(conversation.external_conversation_id, text, account);
      } catch (error) {
        // A notificacao de resposta pode chegar entre a leitura local e o POST.
        // Se outra execucao respondeu primeiro, a consulta remota permite
        // reconciliar o estado. Erros de permissao continuam sendo reportados.
        const reconciled = await reconcileAnsweredMercadoLivreQuestion(conversation, account, requested.draftId);
        if (reconciled) return reconciled;
        throw error;
      }
    } else {
      remote = await sendMercadoLivrePostSaleMessage(String(conversation.raw_data?.reply_resource || conversation.raw_data?.resource || ""), text, account);
    }
  } else {
    const accounts = await getActiveShopeeAccounts();
    const account = accounts.find(item => item.id === conversation.marketplace_account_id);
    if (!account) throw new Error("Conta Shopee da conversa não encontrada.");
    const shopId = account.shop_id || account.account_id;
    if (!shopId) throw new Error("Shop ID da Shopee não configurado.");
    const client = createShopeeClient(await getShopeeOAuthConfig(account.id));
    remote = await client.sendChatText(await getValidShopeeAccessToken(account), shopId, String(conversation.buyer_id || ""), text);
  }
  const now = new Date().toISOString();
  const remoteId = String(remote.message_id || remote.response?.message_id || remote.id || requested.draftId);
  await db.from("marketplace_conversation_messages").update({ external_message_id: remoteId, status: "sent", raw_data: remote })
    .eq("conversation_id", conversationId).eq("external_message_id", requested.draftId).throwOnError();
  await db.from("marketplace_conversations").update({
    status: "answered", requires_response: false, unread: false, last_outgoing_at: now, last_message_at: now,
    last_message_preview: text.slice(0, 240), last_error: null, updated_at: now
  }).eq("id", conversationId).throwOnError();
  return { conversationId, messageId: remoteId, status: "sent", marketplace: conversation.marketplace };
}

export async function markConversationReplyError(activity: Record<string, any>, message: string) {
  const conversationId = String(activity.requested_data?.conversationId || activity.source_id || "");
  if (!conversationId) return;
  const db = supabaseAdmin();
  const current = await db.from("marketplace_conversations").select("external_status,raw_data")
    .eq("id", conversationId).maybeSingle().throwOnError();
  if (String(current.data?.external_status || "").toUpperCase() === "ANSWERED" || current.data?.raw_data?.answer) {
    await db.from("marketplace_conversations").update({ status: "answered", requires_response: false, unread: false, last_error: null, updated_at: new Date().toISOString() })
      .eq("id", conversationId).throwOnError();
    return;
  }
  await Promise.all([
    db.from("marketplace_conversations").update({ status: "error", requires_response: true, unread: true, last_error: message, updated_at: new Date().toISOString() }).eq("id", conversationId),
    db.from("marketplace_conversation_messages").update({ status: "error" }).eq("conversation_id", conversationId).eq("external_message_id", activity.requested_data?.draftId || "")
  ]);
}

async function reconcileAnsweredMercadoLivreQuestion(conversation: Record<string, any>, account: Account, draftId: unknown) {
  let question: Record<string, any>;
  try {
    question = await getMercadoLivreResource(`/questions/${encodeURIComponent(String(conversation.external_conversation_id))}?api_version=4`, account as any);
  } catch {
    return null;
  }
  if (!question.answer) return null;
  const reconciled = await persistMercadoLivreQuestion(question, account);
  if (draftId) {
    await supabaseAdmin().from("marketplace_conversation_messages").delete()
      .eq("conversation_id", conversation.id).eq("external_message_id", String(draftId)).throwOnError();
  }
  return {
    conversationId: reconciled.id,
    messageId: `answer:${question.id}`,
    status: "sent",
    marketplace: "mercado_livre",
    reconciled: true
  };
}

async function persistMercadoLivreQuestion(question: Record<string, any>, account: Account) {
  const db = supabaseAdmin();
  const listingId = String(question.item_id || "");
  const product = await findProduct(account.id, listingId);
  const buyerId = String(question.from?.id || question.buyer_id || "");
  let buyerName = String(question.from?.nickname || question.from?.name || "");
  const existingBuyer = buyerId
    ? await db.from("marketplace_conversations").select("buyer_name").eq("marketplace", "mercado_livre").eq("marketplace_account_id", account.id).eq("buyer_id", buyerId).not("buyer_name", "is", null).order("updated_at", { ascending: false }).limit(1).maybeSingle()
    : { data: null };
  if (buyerId) {
    try {
      const buyer = await getMercadoLivreResource(`/users/${buyerId}`, account as any);
      const nickname = String(buyer.nickname || buyerName || "");
      const realName = [buyer.first_name, buyer.last_name].map(value => String(value || "").trim()).filter(Boolean).join(" ");
      buyerName = realName ? `${titleCase(realName)}${nickname ? ` (${nickname})` : ""}` : nickname;
    } catch { /* dado pode estar protegido */ }
  }
  if (isRicherBuyerName(String(existingBuyer.data?.buyer_name || ""), buyerName)) buyerName = String(existingBuyer.data?.buyer_name);
  const externalStatus = String(question.status || "UNANSWERED").toUpperCase();
  const answered = Boolean(question.answer);
  const closed = isClosedQuestion(externalStatus);
  const removed = question.deleted_from_listing === true;
  const review = /REVIEW|BANNED|DISABLED/.test(externalStatus);
  const createdAt = isoDate(question.date_created) || new Date().toISOString();
  const conversation = await upsertConversation({
    marketplace: "mercado_livre", marketplace_account_id: account.id, external_conversation_id: String(question.id), conversation_type: "question",
    external_status: removed ? `${externalStatus} / REMOVED_FROM_LISTING` : externalStatus, status: answered ? "answered" : closed || removed ? "closed" : review ? "review" : "pending",
    requires_response: !answered && !closed && !removed && !review, unread: !answered && !closed && !removed && !review,
    buyer_id: buyerId || null, buyer_name: buyerName || null, listing_id: listingId || null,
    last_incoming_at: createdAt, last_outgoing_at: isoDate(question.answer?.date_created), last_message_at: isoDate(question.answer?.date_created) || createdAt,
    last_message_preview: String(question.answer?.text || question.text || "").slice(0, 240), raw_data: { ...question, item_permalink: product.item_permalink || null, marketplace_url: product.item_permalink ? `${product.item_permalink}#questions` : null }, ...product
  });
  await upsertMessage(conversation.id, String(question.id), "incoming", String(question.text || ""), buyerId, buyerName, createdAt, question);
  if (question.answer) await upsertMessage(conversation.id, `answer:${question.id}`, "outgoing", String(question.answer.text || ""), String(account.seller_id || account.account_id || ""), account.name, isoDate(question.answer.date_created) || createdAt, question.answer);
  return conversation;
}

async function persistMercadoLivrePostSale(remote: Record<string, any>, account: Account, resource: string) {
  const db = supabaseAdmin();
  const messages = Array.isArray(remote.messages) ? remote.messages : Array.isArray(remote) ? remote : [remote];
  const packId = String(remote.pack_id || remote.order_id || resource.match(/packs\/(\d+)/)?.[1] || "");
  const buyerId = String(remote.buyer_id || remote.from?.user_id || messages[0]?.from?.user_id || "");
  const externalId = String(remote.conversation_id || packId || resource || remote.id);
  const order = packId ? await findOrder("mercado_livre", packId) : null;
  const latest = messages[messages.length - 1] || remote;
  const incoming = String(latest.from?.user_id || latest.sender_id || "") !== String(account.seller_id || account.account_id || "");
  const sentAt = isoDate(latest.message_date?.created || latest.date_created || latest.created_at) || new Date().toISOString();
  const conversation = await upsertConversation({
    marketplace: "mercado_livre", marketplace_account_id: account.id, external_conversation_id: externalId, conversation_type: "post_sale",
    external_status: String(remote.status || "active"), status: incoming ? "pending" : "answered", requires_response: incoming, unread: incoming,
    buyer_id: buyerId || null, buyer_name: String(remote.buyer_name || remote.buyer?.nickname || "") || null, order_id: packId || null,
    last_incoming_at: incoming ? sentAt : null, last_outgoing_at: incoming ? null : sentAt, last_message_at: sentAt,
    last_message_preview: messageText(latest).slice(0, 240), raw_data: { ...remote, resource, reply_resource: resource }, ...(order || {})
  });
  for (const item of messages) {
    const senderId = String(item.from?.user_id || item.sender_id || "");
    const direction = senderId === String(account.seller_id || account.account_id || "") ? "outgoing" : "incoming";
    await upsertMessage(conversation.id, String(item.id || hash(item)), direction, messageText(item), senderId, String(item.from?.nickname || ""), isoDate(item.message_date?.created || item.date_created || item.created_at) || sentAt, item);
  }
  return conversation;
}

async function syncShopeeConversationList(account: ShopeeAccountConfig) {
  const { client, token, shopId } = await shopeeContext(account);
  let cursor = "";
  const seen = new Set<string>();
  const conversations: Array<{ id: string; item: Record<string, any> }> = [];
  for (let page = 0; page < 6; page += 1) {
    const payload = await client.getConversationList(token, shopId, cursor);
    const response = payload.response as Record<string, any> | undefined;
    const list = (response?.conversation_list || response?.conversations || response?.conversation || []) as Array<Record<string, any>>;
    for (const item of list) {
      const conversationId = String(item.conversation_id || item.id || "");
      if (!conversationId || seen.has(conversationId)) continue;
      seen.add(conversationId);
      conversations.push({ id: conversationId, item });
    }
    const pageResult = response?.page_result || response?.page_info || {};
    const nextCursor = pageResult.next_cursor || response?.next_cursor || {};
    const next = String(nextCursor.next_message_time_nano || nextCursor.next_timestamp_nano || pageResult.next_timestamp_nano || "");
    if (!pageResult.more || !next || next === cursor || list.length === 0) break;
    cursor = next;
  }
  for (let index = 0; index < conversations.length; index += 5) {
    await Promise.all(conversations.slice(index, index + 5).map(entry => syncShopeeConversation(account, entry.id, entry.item)));
  }
  return conversations.length;
}

async function syncShopeeConversation(account: ShopeeAccountConfig, conversationId: string, seed: Record<string, any>) {
  const { client, token, shopId } = await shopeeContext(account);
  const [detailPayload, messagePayload] = await Promise.all([
    client.getConversation(token, shopId, conversationId).catch(() => ({ response: seed })),
    client.getConversationMessages(token, shopId, conversationId).catch(() => ({ response: { messages: seed.messages || [] } }))
  ]);
  const detail = ((detailPayload.response as any)?.conversation || detailPayload.response || seed) as Record<string, any>;
  const response = messagePayload.response as Record<string, any> | undefined;
  const messages = ((response?.messages || response?.message_list || response?.message || []) as Array<Record<string, any>>)
    .sort(compareShopeeMessages);
  const latest = messages[messages.length - 1] || detail.last_message || seed;
  const buyerId = String(detail.to_id || detail.peer_id || detail.buyer_id || latest.from_id || latest.sender_id || "");
  const hasSenderInformation = hasShopeeSenderInformation(latest);
  const incoming = hasSenderInformation
    ? !isShopeeSellerMessage(latest, account)
    : Number(detail.unread_count ?? seed.unread_count ?? 0) > 0;
  const itemId = String(latest.content?.item_id || latest.source_content?.item_id || latest.item_id || detail.item_id || seed.latest_message_content?.item_id || "");
  const orderSn = String(latest.content?.order_sn || latest.order_sn || detail.order_sn || "");
  const product = itemId ? await findProduct(account.id, itemId) : orderSn ? await findOrder("shopee", orderSn) : null;
  const sentAt = shopeeDate(latest) || new Date().toISOString();
  const conversation = await upsertConversation({
    marketplace: "shopee", marketplace_account_id: account.id, external_conversation_id: conversationId, conversation_type: "chat",
    external_status: detail.status ? String(detail.status) : "NOT_INFORMED", status: incoming ? "pending" : "answered", requires_response: incoming, unread: incoming,
    buyer_id: buyerId || null, buyer_name: String(detail.to_name || detail.peer_name || detail.buyer_username || "") || null,
    listing_id: itemId || null, order_id: orderSn || null, last_incoming_at: incoming ? sentAt : null, last_outgoing_at: incoming ? null : sentAt,
    last_message_at: sentAt, last_message_preview: messageText(latest).slice(0, 240), raw_data: { ...detail, marketplace_url: "https://seller.shopee.com.br/webchat" }, ...(product || {})
  });
  for (const item of messages) {
    const direction = isShopeeSellerMessage(item, account) ? "outgoing" : "incoming";
    await upsertMessage(conversation.id, String(item.message_id || item.id || hash(item)), direction, messageText(item), String(item.from_id || item.sender_id || ""), direction === "outgoing" ? account.name : String(detail.to_name || detail.peer_name || ""), shopeeDate(item) || sentAt, item);
  }
  return conversation;
}

async function upsertConversation(input: Record<string, any>) {
  const now = new Date().toISOString();
  const db = supabaseAdmin();
  const existing = await db.from("marketplace_conversations")
    .select("reviewed_at")
    .eq("marketplace", input.marketplace)
    .eq("marketplace_account_id", input.marketplace_account_id)
    .eq("external_conversation_id", input.external_conversation_id)
    .maybeSingle();
  if (existing.error) throw new Error(existing.error.message);
  const reviewedAt = existing.data?.reviewed_at ? new Date(existing.data.reviewed_at).getTime() : 0;
  const incomingAt = input.last_message_at ? new Date(input.last_message_at).getTime() : 0;
  if (reviewedAt && incomingAt <= reviewedAt) {
    input = { ...input, status: "answered", requires_response: false, unread: false, reviewed_at: existing.data?.reviewed_at };
  }
  const result = await db.from("marketplace_conversations").upsert({ ...input, updated_at: now }, { onConflict: "marketplace,marketplace_account_id,external_conversation_id" }).select("*").single();
  if (result.error) throw new Error(result.error.message);
  return result.data;
}

async function upsertMessage(conversationId: string, externalId: string, direction: string, text: string, senderId: string, senderName: string, sentAt: string, raw: Record<string, any>) {
  await supabaseAdmin().from("marketplace_conversation_messages").upsert({
    conversation_id: conversationId, external_message_id: externalId, direction, message_type: String(raw.message_type || raw.type || "text"),
    text, sender_id: senderId || null, sender_name: senderName || null, sent_at: sentAt, status: direction === "incoming" ? "received" : "sent", raw_data: raw
  }, { onConflict: "conversation_id,external_message_id", ignoreDuplicates: true }).throwOnError();
}

async function findProduct(accountId: string, listingId: string) {
  if (!listingId) return {};
  const db = supabaseAdmin();
  const link = await db.from("product_marketplaces").select("product_id,sku,titulo_marketplace,valor_marketplace,estoque_marketplace,status_anuncio,raw_data,products(title,price),estoque(estoque_disponivel)")
    .eq("marketplace_account_id", accountId).eq("marketplace_product_id", listingId).maybeSingle();
  const row: any = link.data;
  return row ? { product_id: row.product_id, sku: row.sku, product_title: row.titulo_marketplace || row.products?.title, product_price: row.valor_marketplace || row.products?.price, available_stock: row.estoque?.estoque_disponivel ?? row.estoque_marketplace, product_status: row.status_anuncio, product_image_url: row.raw_data?.image?.image_url_list?.[0] || row.raw_data?.promotion_image?.image_url_list?.[0] || row.raw_data?.thumbnail || null, item_permalink: row.raw_data?.permalink || null } : {};
}

async function findOrder(marketplace: string, orderId: string) {
  const sale = await supabaseAdmin().from("venda").select("order_id,data_venda,venda_item(sku,valor_unitario,raw_data)").eq("marketplace", marketplace).eq("order_id", orderId).maybeSingle();
  const item: any = (sale.data as any)?.venda_item?.[0];
  if (!item) return null;
  const product = await supabaseAdmin().from("products").select("id,title,price,estoque(estoque_disponivel)").eq("sku", item.sku).maybeSingle();
  return { order_id: orderId, purchased_at: (sale.data as any)?.data_venda, product_id: product.data?.id, sku: item.sku, product_title: product.data?.title, product_price: item.valor_unitario || product.data?.price, available_stock: (product.data as any)?.estoque?.estoque_disponivel };
}

async function findMercadoLivreAccount(userId: unknown) {
  const wanted = String(userId || "");
  const account = (await getActiveMercadoLivreAccounts()).find(item => [item.seller_id, item.account_id].some(id => String(id || "") === wanted));
  if (!account) throw new Error(`Conta Mercado Livre ${wanted || "não informada"} não encontrada.`);
  return account as Account;
}

async function shopeeContext(account: ShopeeAccountConfig) {
  const shopId = account.shop_id || account.account_id;
  if (!shopId) throw new Error(`Shop ID não configurado para ${account.name}.`);
  return { client: createShopeeClient(await getShopeeOAuthConfig(account.id)), token: await getValidShopeeAccessToken(account), shopId };
}

export function validateMarketplaceReply(text: string) {
  const blocked: string[] = [];
  const warnings: string[] = [];
  if (!text) blocked.push("Digite uma resposta.");
  if (text.length > 2000) blocked.push("A resposta deve ter no máximo 2.000 caracteres.");
  if (/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/i.test(text)) blocked.push("Não informe ou solicite e-mails.");
  if (/(?:https?:\/\/|www\.|\b(?:bit\.ly|tinyurl\.com|wa\.me)\b)/i.test(text)) blocked.push("Não informe links externos.");
  if (/(?:\+?55\s*)?(?:\(?\d{2}\)?\s*)?(?:9\s*)?\d{4}[-.\s]?\d{4}/.test(text) || /whats(?:app)?/i.test(text)) blocked.push("Não informe ou solicite telefone/WhatsApp.");
  if (/\b(?:pix|chave\s+pix|instagram|facebook|telegram)\b/i.test(text)) blocked.push("Não direcione o contato ou pagamento para fora do marketplace.");
  if (/\b(?:senha|pin|c[oó]digo\s+de\s+seguran[cç]a|cpf|cnpj)\b/i.test(text)) warnings.push("Revise a menção a dados pessoais ou de segurança.");
  if (/\b(?:reclama[cç][aã]o|endere[cç]o|pagamento\s+por\s+fora)\b/i.test(text)) warnings.push("Revise o conteúdo antes de enviar.");
  return { blocked, warnings };
}

function messageText(message: Record<string, any>) {
  const value = message.text || message.content?.text || message.message || "";
  return typeof value === "string" ? value : "";
}
function isClosedQuestion(status: unknown) { return /CLOSED|BANNED|DISABLED/.test(String(status || "").toUpperCase()); }
function isoDate(value: unknown) { if (!value) return null; const date = new Date(String(value)); return Number.isNaN(date.getTime()) ? null : date.toISOString(); }
function shopeeDate(value: Record<string, any>) {
  const raw = value.created_timestamp || value.last_message_timestamp || value.latest_message_timestamp || value.create_time || value.timestamp || value.sent_at;
  if (!raw) return null;
  const number = Number(raw);
  if (!Number.isFinite(number)) return isoDate(raw);
  const milliseconds = number > 1e15 ? Math.floor(number / 1e6) : number > 1e12 ? number : number * 1000;
  return new Date(milliseconds).toISOString();
}
function hasShopeeSenderInformation(message: Record<string, any>) {
  return Boolean(message.from_id || message.from_shop_id || message.sender_id || message.sender_role || message.message_source);
}
function compareShopeeMessages(left: Record<string, any>, right: Record<string, any>) {
  const byDate = (shopeeDate(left) || "").localeCompare(shopeeDate(right) || "");
  if (byDate) return byDate;
  const leftId = BigInt(String(left.message_id || left.id || "0").replace(/\D/g, "") || "0");
  const rightId = BigInt(String(right.message_id || right.id || "0").replace(/\D/g, "") || "0");
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}
function isShopeeSellerMessage(message: Record<string, any>, account: ShopeeAccountConfig) {
  const shopId = String(account.shop_id || account.account_id || "");
  const source = String(message.message_source || message.sender_role || "").toLowerCase();
  return [message.from_id, message.from_shop_id, message.sender_id].some(value => value != null && String(value) === shopId)
    || ["seller", "shop", "merchant"].includes(source);
}
function hash(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function titleCase(value: string) { return value.toLocaleLowerCase("pt-BR").replace(/(^|[\s'-])\p{L}/gu, letter => letter.toLocaleUpperCase("pt-BR")); }
function isRicherBuyerName(candidate: string, current: string) { return Boolean(candidate) && (candidate.includes("(") && !current.includes("(") || candidate.length > current.length + 3); }
function safeError(error: unknown) { return error instanceof Error ? error.message : String(error); }
