"use server";

import { queueShopeeConversationAction } from "@/lib/shopee-chat-management";
import { revalidatePath } from "next/cache";
import { queueConversationReply } from "@/lib/marketplace-conversations";
import { enqueueMarketplaceActivity } from "@/lib/marketplace-queue";
import { supabaseAdmin } from "@/lib/supabase-admin";

export async function sendConversationReply(formData: FormData) {
  const conversationId = String(formData.get("conversationId") || "");
  const text = String(formData.get("text") || "");
  try {
    const activityId = await queueConversationReply(conversationId, text);
    revalidatePath("/chats-perguntas");
    return { ok: true, activityId };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function updateConversationsNow() {
  const result = await enqueueMarketplaceActivity({
    marketplace: "mercado_livre", payload: { topic: "conversation_sync", requested_at: new Date().toISOString() },
    eventType: "conversation_sync", description: "Sincronização manual de chats solicitada."
  });
  revalidatePath("/chats-perguntas");
  return { ok: true, result };
}

export async function retryConversationReply(formData: FormData) {
  const conversationId = String(formData.get("conversationId") || "");
  const db = supabaseAdmin();
  const activity = await db.from("outgoing_marketplace_activities").select("id")
    .eq("source_type", "marketplace_conversation").eq("source_id", conversationId).in("status", ["error", "retry"])
    .order("created_at", { ascending: false }).limit(1).maybeSingle().throwOnError();
  if (!activity.data) return { ok: false, error: "Envio com erro não encontrado." };
  await db.from("outgoing_marketplace_activities").update({ status: "retry", attempt_count: 0, next_attempt_at: new Date().toISOString(), processing_error: null, processed_at: null, updated_at: new Date().toISOString() }).eq("id", activity.data.id).throwOnError();
  await db.from("marketplace_conversations").update({ status: "pending", last_error: null, updated_at: new Date().toISOString() }).eq("id", conversationId).throwOnError();
  revalidatePath("/chats-perguntas");
  return { ok: true };
}

export async function manageShopeeConversation(formData: FormData) {
  try {
    const activityId = await queueShopeeConversationAction(
      String(formData.get("conversationId") || ""),
      String(formData.get("action") || ""),
      String(formData.get("lastMessageId") || "")
    );
    revalidatePath("/atividades-marketplace/enviadas");
    return { ok: true as const, activityId };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function markConversationRead(formData: FormData) {
  formData.set("action", "conversation_read");
  return manageShopeeConversation(formData);
}
