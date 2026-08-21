const { createClient } = require("@supabase/supabase-js");

(async () => {
  const response = await fetch("https://marketplace-ashen-five.vercel.app/api/marketplace-queue/process?limit=50", {
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}` }
  });
  const processing = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(processing));
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    { auth: { persistSession: false } });
  const { data, error } = await db.from("outgoing_marketplace_activities").select("status");
  if (error) throw error;
  const counts = (data || []).reduce((out, row) => ({ ...out, [row.status]: (out[row.status] || 0) + 1 }), {});
  console.log(JSON.stringify({ processing, counts }, null, 2));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
