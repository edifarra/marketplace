import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const maxDuration = 60;
const RETENTION_DAYS = 60;
const MODERATION_RETENTION_DAYS = 30;
const CONVERSATION_RETENTION_MONTHS = 3;

export async function GET(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: "Não autorizado." }, { status: 401 });
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  try {
    const db = supabaseAdmin();
    const conversationCutoffDate = new Date();
    conversationCutoffDate.setUTCMonth(conversationCutoffDate.getUTCMonth() - CONVERSATION_RETENTION_MONTHS);
    const conversationCutoff = conversationCutoffDate.toISOString();
    const moderationCutoff = new Date(Date.now() - MODERATION_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const moderations = await db.from("marketplace_listing_moderations").delete({ count: "exact" }).lt("event_at", moderationCutoff);
    if (moderations.error) throw moderations.error;
    const activities = await db.from("marketplace_activities").delete({ count: "exact" }).lt("received_at", cutoff);
    if (activities.error) throw activities.error;
    const sentActivities = await db.from("outgoing_marketplace_activities").delete({ count: "exact" }).lt("created_at", cutoff);
    if (sentActivities.error) throw sentActivities.error;
    // Logs vinculados são removidos automaticamente ao excluir a execução.
    const runs = await db.from("pipeline_runs").delete({ count: "exact" }).lt("created_at", cutoff);
    if (runs.error) throw runs.error;
    const logs = await db.from("pipeline_logs").delete({ count: "exact" }).lt("created_at", cutoff);
    if (logs.error) throw logs.error;
    const conversations = await db.from("marketplace_conversations").delete({ count: "exact" }).lt("created_at", conversationCutoff);
    if (conversations.error) throw conversations.error;
    return NextResponse.json({
      ok: true, retentionDays: RETENTION_DAYS, cutoff,
      moderationRetentionDays: MODERATION_RETENTION_DAYS,
      conversationRetentionMonths: CONVERSATION_RETENTION_MONTHS, conversationCutoff,
      removed: { marketplaceModerations: moderations.count || 0, marketplaceActivities: activities.count || 0, sentMarketplaceActivities: sentActivities.count || 0, pipelineRuns: runs.count || 0, pipelineLogs: logs.count || 0, marketplaceConversations: conversations.count || 0 }
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

function authorized(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  return Boolean(secret && (
    request.headers.get("authorization") === `Bearer ${secret}`
    || request.headers.get("x-cron-secret") === secret
  ));
}
