import { getCurrentUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { SidebarNavigation } from "./sidebar-navigation";

export async function Sidebar() {
  const user = await getCurrentUser();
  const { data } = await supabaseAdmin().from("settings").select("key,value").in("key", ["SYSTEM_COMPACT_LOGO_URL", "SYSTEM_FULL_LOGO_URL"]);
  const value = (key: string) => String(data?.find(row => row.key === key)?.value || "").replace(/^"|"$/g, "");
  return <SidebarNavigation user={user ? { name: user.name, isMaster: user.isMaster } : null} compactLogo={value("SYSTEM_COMPACT_LOGO_URL")} fullLogo={value("SYSTEM_FULL_LOGO_URL")} />;
}
