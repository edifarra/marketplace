import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());
import { syncCategoryAttributes } from "../lib/marketplace-attributes";
import { supabaseAdmin } from "../lib/supabase-admin";
import { getValidShopeeAccessToken } from "../lib/shopee";
import { createShopeeClient, getShopeeOAuthConfig } from "../lib/shopee-oauth";

const db = supabaseAdmin();
const page = async (table: string, select: string, filter?: (query: any) => any) => {
  const rows: any[] = [];
  for (let from = 0;; from += 1000) {
    let query: any = db.from(table).select(select).range(from, from + 999);
    if (filter) query = filter(query);
    const result = await query.throwOnError(); rows.push(...(result.data || []));
    if ((result.data || []).length < 1000) return rows;
  }
};

async function main() {
  const mappings = await page("marketplace_category_mappings", "*");
  for (const mapping of mappings) {
    try { await syncCategoryAttributes(mapping.internal_category); console.log(`atributos: ${mapping.internal_category}`); }
    catch (error) { console.warn(`atributos falharam: ${mapping.internal_category}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const [products, links, accounts, refreshedMappings, types, brands] = await Promise.all([
    page("products", "id,sku,type_code,brand_code,model,board_code,title,description,product_condition,width,height,length,weight_gross,marketplace_categories,marketplace_attributes"),
    page("product_marketplaces", "product_id,marketplace,marketplace_product_id,marketplace_account_id,raw_data", q => q.eq("existe_no_marketplace", true).not("marketplace_product_id", "is", null)),
    page("config_marketplace_accounts", "*", q => q.eq("active", true)),
    page("marketplace_category_mappings", "*"), page("config_types", "*"), page("config_brands", "code,name")
  ]);
  const typeMap = new Map(types.map(type => [type.code, type])); const brandMap = new Map(brands.map(brand => [brand.code, brand.name]));
  const linksByProduct = new Map<string, any[]>();
  for (const link of links) linksByProduct.set(link.product_id, [...(linksByProduct.get(link.product_id) || []), link]);
  const actual = new Map<string, Record<string, { categoryId: string; attributes: Record<string, any> }>>();
  const mlLinks = links.filter(link => link.marketplace === "mercado_livre");
  await concurrent(mlLinks, 10, async link => {
    const response = await fetch(`https://api.mercadolibre.com/items/${encodeURIComponent(link.marketplace_product_id)}?attributes=category_id,attributes,sale_terms`);
    if (!response.ok) return;
    const item: any = await response.json();
    actual.set(link.product_id, { ...(actual.get(link.product_id) || {}), mercado_livre: { categoryId: String(item.category_id || ""), attributes: mlValues(item) } });
  });
  for (const account of accounts.filter(account => account.marketplace === "shopee")) {
    const accountLinks = links.filter(link => link.marketplace === "shopee" && link.marketplace_account_id === account.id);
    if (!accountLinks.length) continue;
    try {
      const token = await getValidShopeeAccessToken(account); const shopId = account.shop_id || account.account_id;
      const client = createShopeeClient(await getShopeeOAuthConfig(account.id));
      for (let index = 0; index < accountLinks.length; index += 50) {
        const batch = accountLinks.slice(index, index + 50); const response: any = await client.getProductsByIds(token, shopId, batch.map(link => link.marketplace_product_id));
        for (const item of response.response?.item_list || []) {
          const link = batch.find(entry => String(entry.marketplace_product_id) === String(item.item_id)); if (!link) continue;
          actual.set(link.product_id, { ...(actual.get(link.product_id) || {}), shopee: { categoryId: String(item.category_id || ""), attributes: shopeeValues(item) } });
        }
      }
    } catch (error) { console.warn(`Shopee ${account.name}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  let updated = 0;
  await concurrent(products, 20, async product => {
    const type = typeMap.get(product.type_code); const mapping = refreshedMappings.find(item => item.internal_category === type?.marketplace_category);
    const base:any = { categories: { internal_category: type?.marketplace_category || "" }, attributes: {} };
    for (const marketplace of ["mercado_livre", "shopee"] as const) {
      const categoryId=String(mapping?.[`${marketplace}_code`]||""); if(!categoryId) continue;
      base.categories[marketplace]={categoryId,attributes:{}}; const attrs=structuredClone(type?.marketplace_attribute_defaults?.[marketplace]?.attributes||{});
      const defs=mapping?.attribute_definitions?.[marketplace]?.attributes||{};
      for(const definition of Object.values(defs) as any[]){ const value=automatic(definition.systemSource,{...product,brand_name:brandMap.get(product.brand_code)}); if(value) attrs[definition.id]={valueName:value}; }
      if(marketplace==="shopee"){const months=Number(type?.warranty_months||0),ids:any={1:776,2:789,3:799,6:810,12:822,24:831,36:857,60:843},has=months>0&&ids[months];attrs["100370"]||={valueId:String(has?2437:5576),valueName:has?"Supplier Warranty":"No Warranty"};attrs["100121"]||={valueId:String(has?ids[months]:5577),valueName:has?`${months} Months`:"No Warranty"};}
      else {const months=Number(type?.warranty_months||0);if(months){attrs.WARRANTY_TYPE||={valueId:"2230280",valueName:"Garantia do vendedor"};attrs.WARRANTY_TIME||={valueName:`${months} meses`};}}
      base.attributes[marketplace]={categoryId,attributes:attrs};
    }
    const real = actual.get(product.id) || {};
    for (const marketplace of ["mercado_livre", "shopee"] as const) {
      if (!real[marketplace]) continue;
      (base.categories as any)[marketplace] = { categoryId: real[marketplace].categoryId, attributes: {} };
      (base.attributes as any)[marketplace] = { categoryId: real[marketplace].categoryId, attributes: { ...((base.attributes as any)[marketplace]?.attributes || {}), ...real[marketplace].attributes } };
      const matching = refreshedMappings.find(mapping => String(mapping[`${marketplace}_code`]) === real[marketplace].categoryId);
      if (matching) (base.categories as any).internal_category = matching.internal_category;
    }
    const result = await db.from("products").update({ marketplace_categories: base.categories, marketplace_attributes: base.attributes, marketplace_attribute_schema_version: 2 }).eq("id", product.id);
    if (result.error) throw new Error(`${product.sku}: ${result.error.message}`); updated++;
    if (updated % 250 === 0) console.log(`produtos: ${updated}/${products.length}`);
  });
  console.log(JSON.stringify({ products: products.length, links: links.length, actualCategories: actual.size, updated }));
}

function automatic(source:string|undefined,product:any){const map:any={brand:product.brand_name,model:product.model,board_code:product.board_code,sku:product.sku,title:product.title,description:product.description,product_condition:product.product_condition,height:product.height,width:product.width,length:product.length,weight_gross:product.weight_gross};return source&&map[source]!==null&&map[source]!==undefined&&map[source]!==""?String(map[source]):"";}

function mlValues(item: any) { const result: Record<string,any> = {}; for (const row of [...(item.attributes || []), ...(item.sale_terms || [])]) result[String(row.id)] = { ...(row.value_id ? { valueId:String(row.value_id) } : {}), ...(row.value_name ? { valueName:String(row.value_name) } : {}) }; return result; }
function shopeeValues(item: any) { const result: Record<string,any> = {}; for (const row of item.attribute_list || []) { const values=row.attribute_value_list||[]; result[String(row.attribute_id)] = values.length > 1 ? { valueIds:values.map((v:any)=>String(v.value_id||0)), valueNames:values.map((v:any)=>String(v.original_value_name||"")) } : { valueId:String(values[0]?.value_id||""), valueName:String(values[0]?.original_value_name||"") }; } return result; }
async function concurrent<T>(items:T[], size:number, task:(item:T)=>Promise<void>) { let cursor=0; await Promise.all(Array.from({length:Math.min(size,items.length)}, async()=>{ while(cursor<items.length){ const item=items[cursor++]; try{await task(item);}catch(error){console.warn(error);} } })); }
main().catch(error => { console.error(error); process.exit(1); });
