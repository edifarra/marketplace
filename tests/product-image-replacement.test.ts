import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const actionSource = fs.readFileSync(new URL("../app/produtos/actions.ts", import.meta.url), "utf8");
const migrationSource = fs.readFileSync(new URL("../supabase/migrations/091_atomic_product_image_replacement.sql", import.meta.url), "utf8");

test("recuperacao Mercado Livre ou Shopee persiste todas as fotos antes da troca atomica", () => {
  const download = actionSource.indexOf("resolveMarketplaceRecoveryImageUrls");
  const upload = actionSource.indexOf("uploadProductImageToCloudinary", actionSource.indexOf("const recoveredUploads"));
  const replace = actionSource.indexOf('rpc("replace_product_images_atomically"');
  assert.ok(download >= 0 && upload > download && replace > upload);
});

test("falha ao persistir uma imagem nova mantem registros antigos e limpa somente uploads novos", () => {
  assert.match(actionSource, /Não foi possível persistir todas as novas fotos\. As fotos anteriores foram mantidas/);
  assert.match(actionSource, /Promise\.allSettled\(newlyPersistedPublicIds\.map/);
  assert.doesNotMatch(actionSource, /from\("product_images"\)\.delete\(\).*deleteCloudinaryResource/s);
});

test("substituicao completa acontece em uma unica transacao de banco", () => {
  assert.match(migrationSource, /for update/);
  assert.match(migrationSource, /insert into product_images/);
  assert.match(migrationSource, /delete from product_images/);
  assert.ok(migrationSource.indexOf("insert into product_images") < migrationSource.indexOf("delete from product_images"));
  assert.ok(actionSource.indexOf('rpc("replace_product_images_atomically"') < actionSource.indexOf("Promise.allSettled(removed.map"));
});

test("falha da transacao nao inicia cleanup dos registros antigos", () => {
  const rpc = actionSource.indexOf('rpc("replace_product_images_atomically"');
  const committed = actionSource.indexOf("imageReplacementCommitted = true", rpc);
  const cleanupOld = actionSource.indexOf("Promise.allSettled(removed.map", committed);
  assert.ok(rpc >= 0 && committed > rpc && cleanupOld > committed);
});
