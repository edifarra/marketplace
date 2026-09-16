import { normalizeMercadoLivrePostSale } from "../lib/mercado-livre-post-sale";
import { getActiveMercadoLivreAccounts, getMercadoLivrePostSaleConversation } from "../lib/mercado-livre";
import { reconcileMercadoLivrePostSaleConversationPath } from "../lib/marketplace-conversations";
import { supabaseAdmin } from "../lib/supabase-admin";

void main();

async function main() {
  const sellerId = process.argv[2] || "181345701";
  const packId = process.argv[3] || "2000015048475985";
  const db = supabaseAdmin();
  const account = (await getActiveMercadoLivreAccounts()).find(item => String(item.seller_id || item.account_id || "") === sellerId);
  if (!account) throw new Error(`Conta do seller ${sellerId} não encontrada.`);

  const path = `/packs/${packId}/sellers/${sellerId}`;
  const before = await localState();
  const remote = await getMercadoLivrePostSaleConversation(path, account);
  const remoteMessages = normalizeMercadoLivrePostSale(remote, sellerId, account.id);
  const missingBefore = remoteMessages.filter(message => !before.messageIds.has(message.messageId));

  const firstRun = await reconcileMercadoLivrePostSaleConversationPath(account, path);
  const secondRun = await reconcileMercadoLivrePostSaleConversationPath(account, path);
  const after = await localState();
  const missingAfter = remoteMessages.filter(message => !after.messageIds.has(message.messageId));
  const duplicateResult = after.conversationId
    ? await db.from("marketplace_conversation_messages").select("external_message_id").eq("conversation_id", after.conversationId)
    : { data: [], error: null };
  if (duplicateResult.error) throw new Error(duplicateResult.error.message);
  const ids = (duplicateResult.data || []).map(row => String(row.external_message_id));
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);

  console.log(JSON.stringify({
    sellerId, packId, path,
    localBefore: { conversationId: before.conversationId, messages: before.messageIds.size },
    remote: { status: remote.conversation_status?.status || remote.status || null, messages: remoteMessages.length },
    missingBefore: missingBefore.map(message => ({ id: message.messageId, direction: message.direction, sentAt: message.sentAt })),
    firstRun: { conversationId: firstRun.id, status: firstRun.status },
    secondRun: { conversationId: secondRun.id, status: secondRun.status },
    localAfter: { conversationId: after.conversationId, messages: after.messageIds.size },
    missingAfter: missingAfter.map(message => message.messageId), duplicates
  }, null, 2));

  async function localState() {
    const conversation = await db.from("marketplace_conversations").select("id")
      .eq("marketplace", "mercado_livre").eq("marketplace_account_id", account!.id)
      .or(`pack_id.eq.${packId},conversation_path.eq.${path}`).limit(1).maybeSingle().throwOnError();
    if (!conversation.data?.id) return { conversationId: null, messageIds: new Set<string>() };
    const messages = await db.from("marketplace_conversation_messages").select("external_message_id")
      .eq("conversation_id", conversation.data.id).throwOnError();
    return { conversationId: String(conversation.data.id), messageIds: new Set((messages.data || []).map(row => String(row.external_message_id))) };
  }
}
