import nextEnv from "@next/env";
import { createClient } from "@supabase/supabase-js";

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);
const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

const [{ data: sales, error: salesError }, { data: activities, error: activitiesError }, { data: accounts, error: accountsError }, { data: shopeeActivities, error: shopeeActivitiesError }] = await Promise.all([
  db.from("venda").select("marketplace,order_id,status_original,valor_produtos,data_venda,created_at").gte("data_venda", since),
  db.from("marketplace_activities").select("marketplace,status,event_type,received_at").gte("received_at", since),
  db.from("config_marketplace_accounts").select("marketplace,name,status,active,shop_id,seller_id").eq("active", true),
  db.from("marketplace_activities").select("marketplace,status,event_type,received_at").eq("marketplace", "shopee").gte("received_at", since)
]);
if (salesError) throw salesError;
if (activitiesError) throw activitiesError;
if (accountsError) throw accountsError;
if (shopeeActivitiesError) throw shopeeActivitiesError;
activities.push(...(shopeeActivities || []));

const marketplaces = ["mercado_livre", "shopee"];
const summary = Object.fromEntries(marketplaces.map((marketplace) => {
  const marketplaceSales = (sales || []).filter((sale) => sale.marketplace === marketplace);
  const marketplaceActivities = (activities || []).filter((activity) => activity.marketplace === marketplace);
  return [marketplace, {
    sales: marketplaceSales.length,
    grossValue: marketplaceSales.reduce((total, sale) => total + Number(sale.valor_produtos || 0), 0),
    firstSale: marketplaceSales.map((sale) => sale.data_venda || sale.created_at).sort()[0] || null,
    lastSale: marketplaceSales.map((sale) => sale.data_venda || sale.created_at).sort().at(-1) || null,
    statuses: groupBy(marketplaceSales, "status_original"),
    activities: marketplaceActivities.length,
    activityStatuses: groupBy(marketplaceActivities, "status")
  }];
}));

console.log(JSON.stringify({
  period: { since, until: new Date().toISOString() },
  accounts: (accounts || []).map(({ marketplace, name, status, active, shop_id, seller_id }) => ({
    marketplace, name, status, active, hasExternalId: Boolean(shop_id || seller_id)
  })),
  summary
}, null, 2));

function groupBy(rows, key) {
  return rows.reduce((result, row) => {
    const value = String(row[key] || "unknown");
    result[value] = (result[value] || 0) + 1;
    return result;
  }, {});
}
