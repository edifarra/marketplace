// Read-only audit: never calls update, insert, delete, RPC, or marketplace APIs.
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const sku = "1096AU";
const output = path.resolve("docs/image-vps-review");
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } });
const { data: product, error } = await db.from("products")
  .select("id,sku,product_images(id,product_id,position,original_name,url,local_url,local_path,cloudinary_url)")
  .eq("sku", sku).single();
if (error) throw new Error(error.message);
const images = [...product.product_images].sort((a, b) => a.position - b.position);
const base = "https://api.gestaomarketplace.tech/Imagens/Legado/";
const names = [1, 2, 3].map(n => `AUAI_Aws-tv-50-bl-02-a_0${n}.jpg`);
if (images.length !== 3 || images.some((image, index) => image.position !== index + 1 || image.local_url !== base + names[index])) {
  throw new Error("Snapshot do SKU diverge das três posições/URLs esperadas. Nenhum SQL foi preparado.");
}
const checks = await Promise.all(images.map(async image => {
  const response = await fetch(image.local_url, { method: "HEAD", signal: AbortSignal.timeout(15_000) });
  return { position: image.position, url: image.local_url, status: response.status, contentType: response.headers.get("content-type") };
}));
if (checks.some(check => check.status !== 200 || !check.contentType?.startsWith("image/"))) throw new Error("Uma original não passou na verificação HTTP. Nenhum SQL foi preparado.");
const quote = value => value == null ? "NULL" : `'${String(value).replaceAll("'", "''")}'`;
function sql(rollback = false) {
  const guards = images.map(image => `(${["id", "product_id", "position", "local_url", "local_path", "cloudinary_url"].map(key =>
    `${key} IS NOT DISTINCT FROM ${typeof image[key] === "number" ? image[key] : quote(image[key])}`).join(" AND ")}
    AND url IS NOT DISTINCT FROM ${quote(rollback ? image.local_url : image.url)})`).join(" OR\n    ");
  const cases = images.map(image => `WHEN ${quote(image.id)}::uuid THEN ${quote(rollback ? image.url : image.local_url)}`).join("\n      ");
  return `-- Preparado de snapshot real em ${new Date().toISOString()}. NÃO EXECUTADO.
-- Somente url é alterada. local_url, local_path e cloudinary_url são preservados.
-- Revisar snapshot e autorização antes de substituir ROLLBACK por COMMIT.
BEGIN;
SELECT id FROM public.product_images WHERE product_id = ${quote(product.id)}::uuid FOR UPDATE;
DO $review$
DECLARE affected integer;
BEGIN
  IF (SELECT count(*) FROM public.product_images WHERE product_id = ${quote(product.id)}::uuid) <> 3
    OR (SELECT count(*) FROM public.product_images WHERE ${guards}) <> 3
  THEN RAISE EXCEPTION 'Snapshot mudou: interromper e preparar nova revisão'; END IF;
  UPDATE public.product_images SET url = CASE id
      ${cases}
      ELSE url END
  WHERE product_id = ${quote(product.id)}::uuid;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 3 THEN RAISE EXCEPTION 'Quantidade de imagens inesperada'; END IF;
END $review$;
SELECT id, position, url, local_url, local_path, cloudinary_url FROM public.product_images
WHERE product_id = ${quote(product.id)}::uuid ORDER BY position;
ROLLBACK;
`;
}
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, "1096AU-before.json"), JSON.stringify({ observedAt: new Date().toISOString(), product, checks, productionWrites: 0 }, null, 2));
fs.writeFileSync(path.join(output, "1096AU-forward.sql"), sql());
fs.writeFileSync(path.join(output, "1096AU-rollback.sql"), sql(true));
console.log(JSON.stringify({ sku, images: images.length, checks, preparedSqlOnly: true, productionWrites: 0 }, null, 2));
