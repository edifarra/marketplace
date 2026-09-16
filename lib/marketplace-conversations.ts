import { createHash } from "crypto";
import { revalidatePath } from "next/cache";
import { getCurrentUser } from "./auth";
import {
  answerMercadoLivreQuestion,
  getActiveMercadoLivreAccounts,
  getMercadoLivreAccountById,
  getMercadoLivreOrder,
  getMercadoLivrePack,
  getMercadoLivrePostSaleConversation,
  getMercadoLivrePostSaleMessage,
  getMercadoLivreResource,
  getMercadoLivreUnreadPostSaleMessages,
  sendMercadoLivrePostSaleMessage
} from "./mercado-livre";
import { canonicalMercadoLivreConversationId, MLB_MESSAGING_AGENT_ID, normalizeMercadoLivrePostSale, parseMercadoLivreConversationPath } from "./mercado-livre-post-sale";
import { mercadoLivrePostSaleRevision, mercadoLivreQuestionRevision } from "./mercado-livre-conversation-reconciliation";
import { getActiveShopeeAccounts, getValidShopeeAccessToken, ShopeeAccountConfig } from "./shopee";
import { createShopeeClient, getShopeeOAuthConfig } from "./shopee-oauth";
import { enqueueOutgoingActivity } from "./outgoing-activities";
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
      const messages = await syncMercadoLivreUnreadPostSale(account);
      results.push({ account: account.name, marketplace: "mercado_livre", questions: (payload.questions || []).length, messages, ok: true });
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

export async function syncMercadoLivreUnreadPostSaleConversations() {
  const results = [];
  for (const account of await getActiveMercadoLivreAccounts()) {
    try { results.push({ account: account.name, count: await syncMercadoLivreUnreadPostSale(account), ok: true }); }
    catch (error) { results.push({ account: account.name, ok: false, error: safeError(error) }); }
  }
  return results;
}

export async function syncMercadoLivreConversationsIncremental() {
  const results = [];
  for (const account of await getActiveMercadoLivreAccounts()) {
    try {
      results.push({ account: account.name, ...(await syncMercadoLivreAccountIncremental(account)), ok: true });
    } catch (error) {
      results.push({ account: account.name, ok: false, error: safeError(error) });
    }
  }
  return results;
}

export async function syncMarketplaceConversationsSafetyNet() {
  const mercadoLivre = await syncMercadoLivreConversationsIncremental();
  const shopee = [];
  for (const account of await getActiveShopeeAccounts()) {
    try {
      shopee.push({ account: account.name, ...(await syncShopeeConversationsIncremental(account)), ok: true });
    } catch (error) {
      shopee.push({ account: account.name, ok: false, error: safeError(error) });
    }
  }
  return { mercadoLivre, shopee };
}

export async function reconcileMercadoLivrePostSaleConversationPath(account: Account, path: string) {
  const remote = await getMercadoLivrePostSaleConversation(path, account as any);
  return resolveAndPersistMercadoLivrePostSale(remote, account);
}

export async function processMercadoLivreConversationNotification(activity: Record<string, any>, payload: Record<string, any>) {
  const resource = String(payload.resource || "");
  if (String(payload.topic) === "messages" && Array.isArray(payload.actions) && !payload.actions.includes("created")) {
    return { description: "Leitura de mensagem reconhecida." };
  }
  const account = await findMercadoLivreAccount(payload.user_id);
  if (String(payload.topic) === "questions") {
    const question = await getMercadoLivreResource(`${resource}${resource.includes("?") ? "&" : "?"}api_version=4`, account as any);
    const conversation = await persistMercadoLivreQuestion(question, account);
    return { description: question.answer ? "Pergunta respondida." : isClosedQuestion(question.status) ? "Pergunta encerrada." : "Nova pergunta.", conversationId: conversation.id };
  }
  if (String(payload.topic) === "messages") {
    const remote = resource ? await getMercadoLivrePostSaleMessage(resource, account as any) : payload;
    const conversation = await resolveAndPersistMercadoLivrePostSale(remote, account);
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
  const db = supabaseAdmin();
  const conversationResult = await db.from("marketplace_conversations").select("*").eq("id", conversationId).single().throwOnError();
  const conversation = conversationResult.data;
  const validation = validateMarketplaceReply(cleanText, conversation);
  if (validation.blocked.length) throw new Error(validation.blocked.join(" "));
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
    requestedData: { conversationId, text: cleanText, draftId, requestedAt: new Date().toISOString(), operatorId: user.id, operatorName: user.name },
    sourceType: "marketplace_conversation",
    sourceId: conversationId
  });
  await db.from("marketplace_conversations").update({ last_error: null, updated_at: new Date().toISOString() }).eq("id", conversationId).throwOnError();
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
      const packId = String(conversation.pack_id || conversation.order_id || "");
      const sellerId = String(conversation.seller_id || account.seller_id || account.account_id || "");
      const recipientId = resolveReplyRecipient(conversation, sellerId);
      if (!packId || !sellerId || !recipientId) throw new Error("Conversa pós-compra sem pack, seller ou destinatário inequívoco para resposta.");
      const reconciled = await reconcileMercadoLivrePostSaleReply(conversation, account, text, requested.draftId, requested.requestedAt);
      if (reconciled) return reconciled;
      remote = await sendMercadoLivrePostSaleMessage({ packId, sellerId, recipientId, text }, account);
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
  try {
    const finalized = await finalizeConversationReply({ conversationId, draftId: requested.draftId, remoteId, text, sentAt: now, remote });
    return { conversationId, messageId: remoteId, status: "sent", marketplace: conversation.marketplace, reconciled: finalized.reconciled };
  } catch (error) {
    // O POST ja terminou. Antes de permitir retry, confirme o estado remoto para
    // impedir que uma falha apenas local provoque um segundo envio ao marketplace.
    if (conversation.marketplace === "mercado_livre" && conversation.conversation_type === "question") {
      const account = await getMercadoLivreAccountById(conversation.marketplace_account_id);
      const reconciled = await reconcileAnsweredMercadoLivreQuestion(conversation, account, requested.draftId);
      if (reconciled) return reconciled;
    }
    if (conversation.marketplace === "mercado_livre" && conversation.conversation_type === "post_sale") {
      const account = await getMercadoLivreAccountById(conversation.marketplace_account_id);
      const reconciled = await reconcileMercadoLivrePostSaleReply(conversation, account, text, requested.draftId, requested.requestedAt);
      if (reconciled) return reconciled;
    }
    throw error;
  }
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
  await finalizeConversationReply({
    conversationId: conversation.id,
    draftId,
    remoteId: `answer:${question.id}`,
    text: String(question.answer.text || ""),
    sentAt: isoDate(question.answer.date_created) || new Date().toISOString(),
    remote: question.answer
  });
  return {
    conversationId: reconciled.id,
    messageId: `answer:${question.id}`,
    status: "sent",
    marketplace: "mercado_livre",
    reconciled: true
  };
}

async function finalizeConversationReply(input: {
  conversationId: string; draftId: unknown; remoteId: string; text: string; sentAt: string; remote: Record<string, any>;
}) {
  const result = await supabaseAdmin().rpc("finalize_marketplace_conversation_reply", {
    p_conversation_id: input.conversationId,
    p_draft_id: String(input.draftId || ""),
    p_external_message_id: input.remoteId,
    p_text: input.text,
    p_sent_at: input.sentAt,
    p_raw_data: input.remote
  }).throwOnError();
  return (result.data || { reconciled: false }) as { reconciled: boolean };
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

async function persistMercadoLivrePostSale(remote: Record<string, any>, account: Account, context: Record<string, any> = {}) {
  const db = supabaseAdmin();
  const sellerId = String(context.sellerId || account.seller_id || account.account_id || "");
  const messages = normalizeMercadoLivrePostSale(remote, sellerId, account.id).sort((a, b) => a.sentAt.localeCompare(b.sentAt));
  if (!messages.length) throw new Error("Mercado Livre não retornou mensagens pós-compra válidas.");
  const latest = messages[messages.length - 1];
  const packId = String(context.packId || latest.packId || "");
  const orderId = String(context.orderId || latest.orderId || "");
  const conversationPath = String(context.conversationPath || latest.conversationPath || "") || null;
  const conversationType = String(latest.conversationType || "post_sale");
  const externalId = canonicalMercadoLivreConversationId({ conversationPath, packId, orderId, conversationType });
  const order = orderId ? await findOrder("mercado_livre", orderId) : null;
  const incoming = latest.direction === "incoming";
  const status = String(remote.conversation_status?.status || remote.status || "active");
  const blocked = status.toLowerCase() === "blocked";
  const rejected = latest.status === "rejected" || String(latest.moderation?.status || "").toLowerCase() === "rejected";
  const counterpartyId = String(latest.counterpartyId || context.counterpartyId || "") || null;
  const conversation = await upsertConversation({
    marketplace: "mercado_livre", marketplace_account_id: account.id, external_conversation_id: externalId, conversation_type: "post_sale",
    external_status: rejected ? "rejected" : status, status: blocked || rejected ? "blocked" : incoming ? "pending" : "answered", requires_response: incoming && !blocked && !rejected, unread: incoming && !rejected,
    buyer_id: latest.isMessagingAgent ? null : counterpartyId, buyer_name: null, order_id: orderId || null,
    pack_id: packId || null, seller_id: sellerId || null, conversation_path: conversationPath,
    counterparty_id: counterpartyId, messaging_agent: messages.some(message => message.isMessagingAgent),
    last_incoming_at: messages.filter(message => message.direction === "incoming").at(-1)?.sentAt || null,
    last_outgoing_at: messages.filter(message => message.direction === "outgoing").at(-1)?.sentAt || null,
    last_message_at: latest.sentAt, last_message_preview: latest.text.slice(0, 240), raw_data: remote, ...(order || {})
  });
  for (const item of messages) {
    await upsertMessage(conversation.id, item.messageId, item.direction, item.text, item.senderId || "", "", item.sentAt, item.raw, {
      accountId: account.id, externalKey: `ml-message:${item.messageId}`
    });
  }
  return conversation;
}

async function resolveAndPersistMercadoLivrePostSale(remote: Record<string, any>, account: Account) {
  const sellerId = String(account.seller_id || account.account_id || "");
  let normalized = normalizeMercadoLivrePostSale(remote, sellerId, account.id);
  if (!normalized.length) throw new Error("Detalhe da mensagem pós-compra não retornou message_id.");
  const seed = normalized[0];
  let orderId = seed.orderId;
  let packId = seed.packId;
  let conversationPath = seed.conversationPath;
  if (orderId && !packId) {
    const order = await getMercadoLivreOrder(orderId, account as any);
    packId = String(order.pack_id || orderId);
  }
  if (packId && !orderId) {
    const pack: Record<string, any> = await getMercadoLivrePack(packId, account as any).catch(() => ({}));
    const orderIds = (Array.isArray(pack.orders) ? pack.orders : []).map((item: any) => String(item.id || item.order_id || "")).filter(Boolean);
    orderId = await firstLocalMercadoLivreOrder(orderIds) || orderIds[0] || null;
  }
  const resolvedSeller = seed.sellerId || sellerId;
  if (!conversationPath && packId && resolvedSeller) conversationPath = `/packs/${packId}/sellers/${resolvedSeller}`;
  if (conversationPath) {
    const conversation = await getMercadoLivrePostSaleConversation(conversationPath, account as any);
    const detailed = normalizeMercadoLivrePostSale(conversation, sellerId, account.id);
    if (detailed.length) { remote = conversation; normalized = detailed; }
  }
  return persistMercadoLivrePostSale(remote, account, { orderId, packId, sellerId: resolvedSeller, conversationPath });
}

async function syncMercadoLivreUnreadPostSale(account: Account) {
  const unread = await getMercadoLivreUnreadPostSaleMessages(account as any);
  const results = Array.isArray(unread.results) ? unread.results : [];
  let count = 0;
  for (const item of results) {
    const path = String(item.resource || item.path || "");
    if (!path) continue;
    const remote = await getMercadoLivrePostSaleConversation(path, account as any);
    await resolveAndPersistMercadoLivrePostSale(remote, account);
    count += 1;
  }
  return count;
}

async function syncMercadoLivreAccountIncremental(account: Account) {
  const sellerId = String(account.seller_id || account.account_id || "");
  if (!sellerId) throw new Error(`Seller ID não configurado para ${account.name}.`);

  const recent = await getMercadoLivreResource(`/questions/search?seller_id=${encodeURIComponent(sellerId)}&api_version=4&limit=50&sort_fields=date_created&sort_types=DESC`, account as any);
  const questions = Array.isArray(recent.questions) ? recent.questions as Array<Record<string, any>> : [];
  const questionIds = questions.map(question => String(question.id || "")).filter(Boolean);
  const existingQuestions = questionIds.length
    ? await supabaseAdmin().from("marketplace_conversations").select("id,external_conversation_id,raw_data")
      .eq("marketplace", "mercado_livre").eq("marketplace_account_id", account.id)
      .eq("conversation_type", "question").in("external_conversation_id", questionIds).throwOnError()
    : { data: [] as Array<Record<string, any>> };
  const existingQuestionRows = existingQuestions.data || [];
  const revisions = new Map(existingQuestionRows.map(row => [String(row.external_conversation_id), mercadoLivreQuestionRevision(row.raw_data || {})]));
  const questionConversationIds = existingQuestionRows.map(row => String(row.id));
  const existingQuestionMessages = questionConversationIds.length
    ? await supabaseAdmin().from("marketplace_conversation_messages").select("conversation_id,external_message_id")
      .in("conversation_id", questionConversationIds).throwOnError()
    : { data: [] as Array<Record<string, any>> };
  const questionMessageKeys = new Set((existingQuestionMessages.data || []).map(row => `${row.conversation_id}:${row.external_message_id}`));
  const conversationIdByQuestion = new Map(existingQuestionRows.map(row => [String(row.external_conversation_id), String(row.id)]));
  let changedQuestions = 0;
  for (const question of questions) {
    const id = String(question.id || "");
    const conversationId = conversationIdByQuestion.get(id);
    const hasIncoming = conversationId ? questionMessageKeys.has(`${conversationId}:${id}`) : false;
    const hasAnswer = !question.answer || (conversationId ? questionMessageKeys.has(`${conversationId}:answer:${id}`) : false);
    if (!id || (revisions.get(id) === mercadoLivreQuestionRevision(question) && hasIncoming && hasAnswer)) continue;
    await persistMercadoLivreQuestion(question, account);
    changedQuestions += 1;
  }

  const pendingQuestions = await pendingMarketplaceReconciliationRows("mercado_livre", account.id, "question", 5);
  let checkedQuestions = 0;
  for (const conversation of pendingQuestions) {
    if (!questionIds.includes(String(conversation.external_conversation_id))) {
      const question = await getMercadoLivreResource(`/questions/${encodeURIComponent(String(conversation.external_conversation_id))}?api_version=4`, account as any);
      if (mercadoLivreQuestionRevision(conversation.raw_data || {}) !== mercadoLivreQuestionRevision(question)) {
        await persistMercadoLivreQuestion(question, account);
        changedQuestions += 1;
      }
    }
    await markMercadoLivreConversationReconciled(String(conversation.id));
    checkedQuestions += 1;
  }

  const unread = await getMercadoLivreUnreadPostSaleMessages(account as any);
  const unreadItems = Array.isArray(unread.results) ? unread.results as Array<Record<string, any>> : [];
  const checkedPaths = new Set<string>();
  let changedPostSale = 0;
  for (const item of unreadItems) {
    const path = String(item.resource || item.path || "");
    if (!path || checkedPaths.has(path)) continue;
    checkedPaths.add(path);
    const remote = await getMercadoLivrePostSaleConversation(path, account as any);
    await resolveAndPersistMercadoLivrePostSale(remote, account);
    changedPostSale += 1;
  }

  const pendingPostSale = await pendingMarketplaceReconciliationRows("mercado_livre", account.id, "post_sale", 5);
  let checkedPostSale = 0;
  for (const conversation of pendingPostSale) {
    const path = String(conversation.conversation_path || (conversation.pack_id && conversation.seller_id ? `/packs/${conversation.pack_id}/sellers/${conversation.seller_id}` : ""));
    if (path && !checkedPaths.has(path)) {
      const remote = await getMercadoLivrePostSaleConversation(path, account as any);
      if (await mercadoLivrePostSaleNeedsPersistence(conversation, remote, sellerId)) {
        await persistMercadoLivrePostSale(remote, account, conversation);
        changedPostSale += 1;
      }
      checkedPaths.add(path);
    }
    await markMercadoLivreConversationReconciled(String(conversation.id));
    checkedPostSale += 1;
  }

  return { recentQuestions: questions.length, changedQuestions, checkedQuestions, unreadConversations: unreadItems.length, checkedPostSale, changedPostSale };
}

async function mercadoLivrePostSaleNeedsPersistence(conversation: Record<string, any>, remote: Record<string, any>, sellerId: string) {
  if (mercadoLivrePostSaleRevision(conversation.raw_data || {}, sellerId) !== mercadoLivrePostSaleRevision(remote, sellerId)) return true;
  const expected = normalizeMercadoLivrePostSale(remote, sellerId).map(message => message.messageId);
  if (!expected.length) return false;
  const existing = await supabaseAdmin().from("marketplace_conversation_messages").select("external_message_id")
    .eq("conversation_id", conversation.id).in("external_message_id", expected).throwOnError();
  return new Set((existing.data || []).map(row => String(row.external_message_id))).size !== new Set(expected).size;
}

async function pendingMarketplaceReconciliationRows(marketplace: "mercado_livre" | "shopee", accountId: string, conversationType: "question" | "post_sale" | "chat", limit: number) {
  const result = await supabaseAdmin().from("marketplace_conversations")
    .select("id,external_conversation_id,external_status,conversation_path,pack_id,seller_id,raw_data,last_message_at,last_reconciled_at")
    .eq("marketplace", marketplace).eq("marketplace_account_id", accountId)
    .eq("conversation_type", conversationType).eq("requires_response", true)
    .order("last_reconciled_at", { ascending: true, nullsFirst: true }).order("last_message_at", { ascending: false })
    .limit(limit).throwOnError();
  return result.data || [];
}

async function markMercadoLivreConversationReconciled(conversationId: string) {
  await supabaseAdmin().from("marketplace_conversations")
    .update({ last_reconciled_at: new Date().toISOString() }).eq("id", conversationId).throwOnError();
}

async function syncShopeeConversationsIncremental(account: ShopeeAccountConfig) {
  const { client, token, shopId } = await shopeeContext(account);
  const payload = await client.getConversationList(token, shopId, "", 50);
  const response = payload.response as Record<string, any> | undefined;
  const recent = (response?.conversation_list || response?.conversations || response?.conversation || []) as Array<Record<string, any>>;
  const ids = recent.map(item => String(item.conversation_id || item.id || "")).filter(Boolean);
  const existing = ids.length
    ? await supabaseAdmin().from("marketplace_conversations").select("external_conversation_id,external_status,last_message_at")
      .eq("marketplace", "shopee").eq("marketplace_account_id", account.id).in("external_conversation_id", ids).throwOnError()
    : { data: [] as Array<Record<string, any>> };
  const localById = new Map((existing.data || []).map(row => [String(row.external_conversation_id), row]));
  const checked = new Set<string>();
  let changed = 0;
  for (const item of recent) {
    const id = String(item.conversation_id || item.id || "");
    if (!id) continue;
    const local = localById.get(id);
    const remoteAt = shopeeDate(item.last_message || item) || "";
    const remoteStatus = String(item.status || item.conversation_status || "");
    const shouldSync = !local || Number(item.unread_count || 0) > 0 || (remoteAt && remoteAt > String(local.last_message_at || "")) || (remoteStatus && remoteStatus !== String(local.external_status || ""));
    if (!shouldSync) continue;
    await syncShopeeConversation(account, id, item);
    checked.add(id);
    changed += 1;
  }

  const pending = await pendingMarketplaceReconciliationRows("shopee", account.id, "chat", 5);
  let rotated = 0;
  for (const conversation of pending) {
    const id = String(conversation.external_conversation_id || "");
    if (id && !checked.has(id)) await syncShopeeConversation(account, id, conversation.raw_data || {});
    await markMercadoLivreConversationReconciled(String(conversation.id));
    rotated += 1;
  }
  return { recentConversations: recent.length, changed, rotated };
}

async function firstLocalMercadoLivreOrder(orderIds: string[]) {
  if (!orderIds.length) return null;
  const result = await supabaseAdmin().from("venda").select("order_id").eq("marketplace", "mercado_livre").in("order_id", orderIds).limit(1).maybeSingle();
  return result.data?.order_id ? String(result.data.order_id) : null;
}

function resolveReplyRecipient(conversation: Record<string, any>, sellerId: string) {
  const explicit = String(conversation.counterparty_id || "");
  if (explicit && explicit !== sellerId) return explicit;
  const pathType = parseMercadoLivreConversationPath(String(conversation.conversation_path || "")).conversationType;
  if (conversation.messaging_agent || pathType) return MLB_MESSAGING_AGENT_ID;
  const buyer = String(conversation.buyer_id || "");
  return buyer && buyer !== sellerId ? buyer : "";
}

async function reconcileMercadoLivrePostSaleReply(conversation: Record<string, any>, account: Account, text: string, draftId: unknown, requestedAt: unknown) {
  const path = String(conversation.conversation_path || (conversation.pack_id && conversation.seller_id ? `/packs/${conversation.pack_id}/sellers/${conversation.seller_id}` : ""));
  if (!path) return null;
  try {
    const remote = await getMercadoLivrePostSaleConversation(path, account as any);
    const since = new Date(String(requestedAt || 0)).getTime() - 60_000;
    const match = normalizeMercadoLivrePostSale(remote, String(conversation.seller_id || account.seller_id || account.account_id || ""), account.id)
      .find(message => message.direction === "outgoing" && message.text === text && new Date(message.sentAt).getTime() >= since);
    if (!match) return null;
    await persistMercadoLivrePostSale(remote, account, conversation);
    await finalizeConversationReply({ conversationId: conversation.id, draftId, remoteId: match.messageId, text: match.text, sentAt: match.sentAt, remote: match.raw });
    return { conversationId: conversation.id, messageId: match.messageId, status: "sent", marketplace: "mercado_livre", reconciled: true };
  } catch { return null; }
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
  const sentAt = shopeeDate(latest) || new Date().toISOString();
  const externalStatus = detail.status ? String(detail.status) : "NOT_INFORMED";
  const status = incoming ? "pending" : "answered";
  const preview = messageText(latest).slice(0, 240);
  const existing = await supabaseAdmin().from("marketplace_conversations")
    .select("*,marketplace_conversation_messages(external_message_id)")
    .eq("marketplace", "shopee").eq("marketplace_account_id", account.id)
    .eq("external_conversation_id", conversationId).maybeSingle().throwOnError();
  const expectedMessageIds = messages.map(item => String(item.message_id || item.id || hash(item)));
  const existingMessageIds = new Set((existing.data?.marketplace_conversation_messages || []).map((item: Record<string, any>) => String(item.external_message_id)));
  const stateUnchanged = existing.data
    && String(existing.data.external_status || "") === externalStatus
    && String(existing.data.status || "") === status
    && Boolean(existing.data.requires_response) === incoming
    && String(existing.data.last_message_at || "") === sentAt
    && String(existing.data.last_message_preview || "") === preview
    && expectedMessageIds.every(id => existingMessageIds.has(id));
  if (stateUnchanged) return existing.data;

  const product = itemId ? await findProduct(account.id, itemId) : orderSn ? await findOrder("shopee", orderSn) : null;
  const conversation = await upsertConversation({
    marketplace: "shopee", marketplace_account_id: account.id, external_conversation_id: conversationId, conversation_type: "chat",
    external_status: externalStatus, status, requires_response: incoming, unread: incoming,
    buyer_id: buyerId || null, buyer_name: String(detail.to_name || detail.peer_name || detail.buyer_username || "") || null,
    listing_id: itemId || null, order_id: orderSn || null, last_incoming_at: incoming ? sentAt : null, last_outgoing_at: incoming ? null : sentAt,
    last_message_at: sentAt, last_message_preview: preview, raw_data: { ...detail, marketplace_url: "https://seller.shopee.com.br/webchat" }, ...(product || {})
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

async function upsertMessage(conversationId: string, externalId: string, direction: string, text: string, senderId: string, senderName: string, sentAt: string, raw: Record<string, any>, identity?: { accountId: string; externalKey: string }) {
  const db = supabaseAdmin();
  if (identity) {
    const existing = await db.from("marketplace_conversation_messages").select("id,conversation_id")
      .eq("marketplace_account_id", identity.accountId).eq("external_message_key", identity.externalKey).maybeSingle().throwOnError();
    if (existing.data) {
      await db.from("marketplace_conversation_messages").update({ conversation_id: conversationId, direction, text, sender_id: senderId || null,
        sender_name: senderName || null, sent_at: sentAt, status: direction === "incoming" ? "received" : "sent", raw_data: raw })
        .eq("id", existing.data.id).throwOnError();
      return;
    }
  }
  await db.from("marketplace_conversation_messages").upsert({
    conversation_id: conversationId, external_message_id: externalId, direction, message_type: String(raw.message_type || raw.type || "text"),
    text, sender_id: senderId || null, sender_name: senderName || null, sent_at: sentAt, status: direction === "incoming" ? "received" : "sent", raw_data: raw,
    marketplace_account_id: identity?.accountId || null, external_message_key: identity?.externalKey || null
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
  const sale = await supabaseAdmin().from("venda").select("order_id,data_venda,raw_data,venda_item(sku,valor_unitario,raw_data)").eq("marketplace", marketplace).eq("order_id", orderId).maybeSingle();
  const item: any = (sale.data as any)?.venda_item?.[0];
  if (!item) return null;
  const product = await supabaseAdmin().from("products").select("id,title,price,estoque(estoque_disponivel)").eq("sku", item.sku).maybeSingle();
  const listingId = String(item.raw_data?.item?.id || item.raw_data?.item_id || (sale.data as any)?.raw_data?.order_items?.[0]?.item?.id || "") || null;
  return { order_id: orderId, listing_id: listingId, purchased_at: (sale.data as any)?.data_venda, product_id: product.data?.id, sku: item.sku, product_title: product.data?.title, product_price: item.valor_unitario || product.data?.price, available_stock: (product.data as any)?.estoque?.estoque_disponivel };
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

export function validateMarketplaceReply(text: string, conversation?: Record<string, any>) {
  const blocked: string[] = [];
  const warnings: string[] = [];
  if (!text) blocked.push("Digite uma resposta.");
  const maximum = conversation?.marketplace === "mercado_livre" && conversation?.conversation_type === "post_sale" ? 350 : 2000;
  if (text.length > maximum) blocked.push(`A resposta deve ter no máximo ${maximum.toLocaleString("pt-BR")} caracteres.`);
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
