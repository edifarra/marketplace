require("@next/env").loadEnvConfig(process.cwd());
const { createClient } = require("@supabase/supabase-js");
(async () => {
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const { data, error } = await db.from("outgoing_marketplace_activities").select("id,sku,listing_id,status,activity_type,destination,processing_error,attempt_count,created_at");
  if (error) throw error;
  const pending = (data || []).filter(row => ["queued", "processing", "retry"].includes(row.status));
  const counts = (data || []).reduce((out, row) => ({ ...out, [row.status]: (out[row.status] || 0) + 1 }), {});
  console.log(JSON.stringify({ counts, pending }, null, 2));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
