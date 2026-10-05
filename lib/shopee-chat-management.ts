import "server-only";
import { getCurrentUser } from "./auth";
import { supabaseAdmin } from "./supabase-admin";
import { getActiveShopeeAccounts, getValidShopeeAccessToken } from "./shopee";
import { createShopeeClient, getShopeeOAuthConfig } from "./shopee-oauth";
import { assertShopeeChatReceipt, validShopeeMessageId } from "./shopee-chat-management-state";

export async function queueShopeeConversationAction(conversationId: string, action: string, lastMessageId: string) {
  const user = await getCurrentUser();
  if (!user) throw new Error("Sessão expirada.");
  if (!["conversation_read", "conversation_delete"].includes(action)) throw new Error("Ação de chat inválida.");
  if (!validShopeeMessageId(lastMessageId)) throw new Error("Atualize o chat para obter o ID da última mensagem.");
  const result = await supabaseAdmin().rpc("enqueue_shopee_conversation_action", {
    p_conversation_id: conversationId, p_action: action, p_last_message_id: lastMessageId,
    p_operator_id: user.id, p_operator_name: user.name
  }).throwOnError();
  return String(result.data);
}

export async function executeShopeeConversationAction(activity: Record<string, any>) {
  if (activity.destination !== "shopee" || !["conversation_read", "conversation_delete"].includes(activity.activity_type))
    throw new Error("Ação de chat disponível somente para Shopee.");
  const requested = activity.requested_data || {};
  const db = supabaseAdmin();
  const conversation = (await db.from("marketplace_conversations").select("*")
    .eq("id", activity.source_id).single().throwOnError()).data;
  if (conversation.marketplace !== "shopee" || conversation.marketplace_account_id !== activity.marketplace_account_id
    || requested.conversationId !== conversation.id || requested.externalConversationId !== conversation.external_conversation_id)
    throw new Error("Conta ou conversa divergente da ação enfileirada.");
  const watermark = validShopeeMessageId(requested.lastMessageId);
  if (!watermark) throw new Error("Ação de chat sem ID válido da última mensagem.");
  // Persist the remote receipt before local finalization. A retry then only finishes
  // the local transaction and cannot delete a newly reopened remote conversation.
  const saved = (await db.from("outgoing_marketplace_activities").select("confirmed_data")
    .eq("id", activity.id).single().throwOnError()).data?.confirmed_data;
  let receipt = saved?.shopeeChatReceipt;
  if (!receipt) {
    const account = (await getActiveShopeeAccounts()).find(item => item.id === conversation.marketplace_account_id);
    if (!account) throw new Error("Conta Shopee ativa da conversa não encontrada.");
    const shopId = account.shop_id || account.account_id;
    if (!shopId) throw new Error("Shop ID da Shopee não configurado.");
    const client = createShopeeClient(await getShopeeOAuthConfig(account.id));
    const token = await getValidShopeeAccessToken(account);
    if (activity.activity_type === "conversation_delete") {
      const detailPayload = await client.getConversation(token, shopId, conversation.external_conversation_id);
      const detail = (detailPayload.response as any)?.conversation || detailPayload.response;
      const remoteLatest = validShopeeMessageId((detail as any)?.latest_message_id);
      if (!remoteLatest || BigInt(remoteLatest) > BigInt(watermark))
        throw new Error("A conversa mudou na Shopee. Atualize e solicite a exclusão novamente.");
      receipt = await client.deleteConversation(token, shopId, conversation.external_conversation_id);
    } else {
      receipt = await client.readConversation(token, shopId, conversation.external_conversation_id, watermark);
    }
    assertShopeeChatReceipt(receipt);
    await db.from("outgoing_marketplace_activities").update({
      confirmed_data: { shopeeChatReceipt: receipt }, updated_at: new Date().toISOString()
    }).eq("id", activity.id).throwOnError();
  } else assertShopeeChatReceipt(receipt);
  await db.rpc("finalize_shopee_conversation_action", { p_activity_id: activity.id }).throwOnError();
  return { conversationId: conversation.id, action: activity.activity_type, marketplace: "shopee", shopeeChatReceipt: receipt };
}
