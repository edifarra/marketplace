require("@next/env").loadEnvConfig(process.cwd());
const { createClient } = require("@supabase/supabase-js");
(async () => {
  const sku = process.argv[2];
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const { data, error } = await db.from("products").select("id,sku,title,product_condition,tiny_product_id,listings(id,marketplace,marketplace_account_id,external_listing_id,status),product_marketplaces(id,marketplace,marketplace_account_id,marketplace_product_id,status_anuncio,existe_no_marketplace)").ilike("sku", sku).single();
  if (error) throw error;
  console.log(JSON.stringify(data, null, 2));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
