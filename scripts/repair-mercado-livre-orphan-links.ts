import { loadEnvConfig } from "@next/env";
import fs from "node:fs";

loadEnvConfig(process.cwd());

async function main() {
  const { supabaseAdmin } = await import("../lib/supabase-admin");
  const { getActiveMercadoLivreAccounts, getMercadoLivreItem } = await import("../lib/mercado-livre");
  const db = supabaseAdmin();
  const apply = process.argv.includes("--apply");
  const accounts = await getActiveMercadoLivreAccounts();
  const { data: listings } = await db.from("listings")
    .select("*,products(sku,title)").eq("marketplace", "mercado_livre")
    .is("marketplace_account_id", null).not("external_listing_id", "is", null).throwOnError();
  const report: Record<string, unknown>[] = [];
  for (const listing of listings || []) {
    try {
      let item: Record<string, any> | undefined;
      const failures: string[] = [];
      for (const account of accounts) {
        try { item = await getMercadoLivreItem(listing.external_listing_id, account); break; }
        catch (error) { failures.push(`${account.name}: ${error instanceof Error ? error.message : String(error)}`); }
      }
      if (!item) throw new Error(failures.join("; "));
      const owners = accounts.filter(account => String(account.seller_id || account.account_id) === String(item.seller_id));
      if (owners.length !== 1) throw new Error("Seller sem conta proprietaria unica.");
      const owner = owners[0];
      const itemSku = String(item.attributes?.find((attribute: any) => attribute.id === "SELLER_SKU")?.value_name || item.seller_custom_field || "").trim();
      const variationSkus = (item.variations || []).map((variation: any) => String(variation.attributes?.find((attribute: any) => attribute.id === "SELLER_SKU")?.value_name || variation.seller_custom_field || "").trim()).filter(Boolean);
      const sku = itemSku || (variationSkus.includes(listing.products.sku) ? listing.products.sku : "");
      if (!sku && item.variations?.length) {
        const { data: links } = await db.from("product_marketplace_variations").select("id,sku,product_id,variation_id")
          .eq("marketplace_account_id", owner.id).eq("parent_listing_id", item.id).throwOnError();
        const matches = (links || []).filter(link => link.sku.toUpperCase() === listing.products.sku.toUpperCase()
          && item!.variations.some((variation: any) => String(variation.id) === link.variation_id));
        if (matches.length !== 1 || matches[0].product_id === listing.product_id) throw new Error("Variacao sem vinculo canonico unico em outro produto.");
        const { data: canonical } = await db.from("products").select("sku").eq("id", matches[0].product_id).single().throwOnError();
        if (canonical.sku.toUpperCase() !== listing.products.sku.toUpperCase()) throw new Error("SKU da variacao nao corresponde ao produto canonico.");
        if (apply) await db.from("listings").delete().eq("id", listing.id)
          .eq("external_listing_id", item.id).is("marketplace_account_id", null).throwOnError();
        const result = { listingId: listing.id, externalId: item.id, sku: listing.products.sku, account: owner.name,
          status: item.status, canonicalProductId: matches[0].product_id, variationId: matches[0].variation_id,
          action: "remove_duplicate_orphan_preserve_canonical_variation", applied: apply };
        report.push(result);
        console.log(JSON.stringify(result));
        continue;
      }
      if (!sku || sku !== listing.products.sku) throw new Error(`SKU externo ${sku} diverge de ${listing.products.sku}.`);
      if (item.id !== listing.external_listing_id) throw new Error("ID retornado diverge do anuncio consultado.");
      const { data: existing } = await db.from("product_marketplaces").select("id,product_id")
        .eq("marketplace_account_id", owner.id).eq("marketplace_product_id", item.id).maybeSingle().throwOnError();
      if (existing && existing.product_id !== listing.product_id) throw new Error("Anuncio ja vinculado a outro produto.");
      const result = { listingId: listing.id, productId: listing.product_id, sku, externalId: item.id,
        accountId: owner.id, account: owner.name, sellerId: item.seller_id, status: item.status,
        price: item.price, stock: item.available_quantity, applied: false };
      if (apply) {
        // Preserve extra announcements in the per-announcement table. Listings
        // permits only one operational row per product/account.
        await db.from("product_marketplaces").upsert({ product_id: listing.product_id,
          marketplace: "mercado_livre", marketplace_account_id: owner.id, marketplace_product_id: item.id,
          sku, titulo_marketplace: item.title, status_anuncio: item.status,
          valor_marketplace: item.price, estoque_marketplace: item.available_quantity,
          existe_no_marketplace: !item.deleted && item.status !== "closed",
          user_product_id: item.user_product_id || null, family_id: item.family_id ? String(item.family_id) : null,
          family_name: item.family_name || null, raw_data: item, updated_at: new Date().toISOString()
        }, { onConflict: "marketplace_account_id,marketplace_product_id" }).throwOnError();
        const { data: confirmed } = await db.from("product_marketplaces").select("product_id,marketplace_account_id")
          .eq("marketplace_account_id", owner.id).eq("marketplace_product_id", item.id).single().throwOnError();
        if (confirmed.product_id !== listing.product_id) throw new Error("Vinculo gravado nao confirmado.");
        await db.from("listings").delete().eq("id", listing.id)
          .eq("external_listing_id", item.id).is("marketplace_account_id", null).throwOnError();
        result.applied = true;
      }
      report.push(result);
      console.log(JSON.stringify(result));
    } catch (error) {
      const result = { listingId: listing.id, externalId: listing.external_listing_id,
        applied: false, error: error instanceof Error ? error.message : String(error) };
      report.push(result);
      console.log(JSON.stringify(result));
      process.exitCode = 1;
    }
  }
  fs.mkdirSync("work", { recursive: true });
  fs.writeFileSync("work/mercado-livre-orphan-link-report.json", JSON.stringify(report, null, 2));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
