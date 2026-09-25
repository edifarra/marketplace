import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getMercadoLivreAccountById, getMercadoLivreAttachment } from "@/lib/mercado-livre";
import { serveMercadoLivreAttachment } from "@/lib/marketplace-attachment-proxy";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: { messageId: string } }) {
  const index = Number(request.nextUrl.searchParams.get("index") || "0");
  return serveMercadoLivreAttachment(params.messageId, index, {
    authenticated: async () => Boolean(await getCurrentUser()),
    loadMessage: async messageId => {
      const result = await supabaseAdmin().from("marketplace_conversation_messages")
        .select("id,conversation_id,raw_data").eq("id", messageId).maybeSingle().throwOnError();
      return result.data;
    },
    loadConversation: async conversationId => {
      const result = await supabaseAdmin().from("marketplace_conversations")
        .select("id,marketplace,marketplace_account_id").eq("id", conversationId).maybeSingle().throwOnError();
      return result.data;
    },
    loadAccount: accountId => getMercadoLivreAccountById(accountId),
    fetchAttachment: (attachmentId, tag, account) => getMercadoLivreAttachment(attachmentId, tag, account as any)
  });
}
