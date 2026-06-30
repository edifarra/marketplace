import { supabaseAdmin } from "./supabase-admin";

export async function logMarketplaceAccountEvent(
  level: "info" | "warn" | "error",
  message: string,
  payload: Record<string, unknown> = {}
) {
  try {
    await supabaseAdmin().from("pipeline_logs").insert({
      level,
      message,
      payload: {
        stage: "marketplace_oauth",
        ...payload
      }
    });
  } catch (error) {
    console.error("[marketplace_oauth_log]", error);
  }
}
