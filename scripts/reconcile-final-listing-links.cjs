const fs = require("fs");
require("@next/env").loadEnvConfig(process.cwd());

for (const file of ["tmp/.env.production", ".env.vercel.local"]) {
  if (!fs.existsSync(file)) continue;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
}

const { createClient } = require("@supabase/supabase-js");

async function main() {
  const fix = process.argv.includes("--fix");
  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    { auth: { persistSession: false } }
  );
  const [links, listings, finalModerations] = await Promise.all([
    allRows((from, to) => db.from("product_marketplaces")
      .select("id,product_id,sku,marketplace,marketplace_account_id,marketplace_product_id,existe_no_marketplace,status_anuncio,raw_data")
      .range(from, to)),
    allRows((from, to) => db.from("listings")
      .select("id,product_id,marketplace,marketplace_account_id,external_listing_id,external_sku,status")
      .range(from, to)),
    allRows((from, to) => db.from("marketplace_listing_moderations")
      .select("id,marketplace,marketplace_account_id,listing_id,sku,status,classification,event_at")
      .eq("classification", "final")
      .range(from, to))
  ]);
  const storedFinalLinks = links.filter(isFinalLink);
  const moderationFinalKeys = new Set(finalModerations.map(keyForModeration));
  const finalKeys = new Set([...storedFinalLinks.map(keyForLink), ...moderationFinalKeys]);
  const finalLinks = links.filter((row) => finalKeys.has(keyForLink(row)));
  const orphanListings = listings.filter((row) => finalKeys.has(keyForListing(row)));
  const incorrectlyLinked = finalLinks.filter((row) => row.product_id || row.existe_no_marketplace !== false);

  if (fix) {
    for (const ids of batches(incorrectlyLinked.map((row) => row.id), 100)) {
      await required(db.from("product_marketplaces").update({
        product_id: null,
        existe_no_marketplace: false,
        updated_at: new Date().toISOString()
      }).in("id", ids));
    }
    for (const ids of batches(orphanListings.map((row) => row.id), 100)) {
      await required(db.from("listings").delete().in("id", ids));
    }
  }

  console.log(JSON.stringify({
    mode: fix ? "fixed" : "audit",
    finalModerationRows: finalModerations.length,
    finalKeysFromModeration: moderationFinalKeys.size,
    finalKeysFromStoredStatus: storedFinalLinks.length,
    finalMarketplaceRows: finalLinks.length,
    incorrectlyLinkedCount: incorrectlyLinked.length,
    orphanListingsCount: orphanListings.length,
    incorrectlyLinkedSample: incorrectlyLinked.slice(0, 20).map(summaryLink),
    orphanListingsSample: orphanListings.slice(0, 20).map(summaryListing),
    correctedMarketplaceRows: fix ? incorrectlyLinked.length : 0,
    deletedListingRows: fix ? orphanListings.length : 0
  }, null, 2));
}

function isFinalLink(row) {
  const status = String(row.status_anuncio || row.raw_data?.status || row.raw_data?.item_status || "");
  if (row.marketplace === "mercado_livre") {
    const subs = Array.isArray(row.raw_data?.sub_status) ? row.raw_data.sub_status.map((value) => String(value).toLowerCase()) : [];
    return ["closed", "inactive"].includes(status.toLowerCase()) || subs.includes("forbidden");
  }
  return ["SHOPEE_DELETE", "SELLER_DELETE", "DELETED", "BANNED"].includes(status.toUpperCase());
}

function keyForLink(row) { return `${row.marketplace_account_id}:${row.marketplace_product_id}`; }
function keyForListing(row) { return `${row.marketplace_account_id}:${row.external_listing_id}`; }
function keyForModeration(row) { return `${row.marketplace_account_id}:${row.listing_id}`; }
function summaryLink(row) { return { id: row.id, sku: row.sku, marketplace: row.marketplace, listingId: row.marketplace_product_id, status: row.status_anuncio }; }
function summaryListing(row) { return { id: row.id, sku: row.external_sku, marketplace: row.marketplace, listingId: row.external_listing_id, status: row.status }; }
function batches(values, size) { const result = []; for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size)); return result; }
async function required(promise) { const result = await promise; if (result.error) throw result.error; return result.data; }
async function allRows(loader) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const result = await loader(from, from + 999);
    if (result.error) throw result.error;
    rows.push(...(result.data || []));
    if (!result.data || result.data.length < 1000) return rows;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
