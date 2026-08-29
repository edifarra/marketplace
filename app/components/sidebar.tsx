import { getCurrentUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { SidebarNavigation } from "./sidebar-navigation";

export async function Sidebar() {
  const user = await getCurrentUser();
  const [{ data }, pending] = await Promise.all([
    supabaseAdmin().from("settings").select("key,value").in("key", ["SYSTEM_COMPACT_LOGO_URL", "SYSTEM_FULL_LOGO_URL"]),
    supabaseAdmin().from("marketplace_conversations").select("id", { count: "exact", head: true }).eq("requires_response", true)
  ]);
  const value = (key: string) => String(data?.find(row => row.key === key)?.value || "").replace(/^"|"$/g, "");
  return <SidebarNavigation user={user ? { name: user.name, isMaster: user.isMaster } : null} compactLogo={value("SYSTEM_COMPACT_LOGO_URL")} fullLogo={value("SYSTEM_FULL_LOGO_URL")} pendingConversations={pending.count || 0} />;
}
