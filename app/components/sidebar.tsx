import { getCurrentUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { SidebarNavigation } from "./sidebar-navigation";
import { ACTIVE_ACTION_FILTER, CLAIM_CONTEXT_FILTER } from "@/lib/marketplace-case-context";
import { CHAT_CONVERSATION_TYPES } from "@/lib/marketplace-conversation-scope";

export async function Sidebar() {
  const user = await getCurrentUser();
  const [{ data }, pending, claims] = await Promise.all([
    supabaseAdmin().from("settings").select("key,value").in("key", ["SYSTEM_COMPACT_LOGO_URL", "SYSTEM_FULL_LOGO_URL"]),
    // Read/delete actions and reconciliation already preserve these persisted flags.
    // A pending status alone must never reactivate the menu after marking a chat read.
    supabaseAdmin().from("marketplace_conversations").select("id", { count: "exact", head: true })
      .in("conversation_type", CHAT_CONVERSATION_TYPES)
      .eq("requires_response", true).eq("unread", true)
      .in("status", ["pending", "error"]).is("shopee_deleted_at", null),
    supabaseAdmin().from("marketplace_cases").select("id", { count: "exact", head: true }).or(CLAIM_CONTEXT_FILTER).or(ACTIVE_ACTION_FILTER)
  ]);
  const value = (key: string) => String(data?.find(row => row.key === key)?.value || "").replace(/^"|"$/g, "");
  return <SidebarNavigation user={user ? { name: user.name, isMaster: user.isMaster } : null} compactLogo={value("SYSTEM_COMPACT_LOGO_URL")} fullLogo={value("SYSTEM_FULL_LOGO_URL")} pendingConversations={pending.count || 0} pendingClaims={claims.count || 0} />;
}
