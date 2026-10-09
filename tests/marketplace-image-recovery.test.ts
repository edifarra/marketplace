import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { extractMarketplaceImageUrls, extractMercadoLivreImageUrls, selectBestMercadoLivrePictureUrl } from "../lib/marketplace-image-recovery";
import { validateMarketplaceImage } from "../lib/marketplace-image-validation";
import { orderMarketplaceAccounts } from "../lib/marketplace-temporary-images";

const recoverySource = fs.readFileSync(new URL("../lib/marketplace-image-recovery.ts", import.meta.url), "utf8");
const temporaryRecoverySource = fs.readFileSync(new URL("../lib/marketplace-temporary-images.ts", import.meta.url), "utf8");

test("produto com Shopee e ML tenta todas as contas Shopee antes do ML", () => {
  const ordered = orderMarketplaceAccounts([
    { id: "s2", marketplace: "shopee", name: "Shopee 2", created_at: "2025-04-01" },
    { id: "m2", marketplace: "mercado_livre", name: "Mercado Livre 2", created_at: "2025-02-01" },
    { id: "s1", marketplace: "shopee", name: "Shopee 1", created_at: "2025-03-01" },
    { id: "m1", marketplace: "mercado_livre", name: "Mercado Livre 1", created_at: "2025-01-01" }
  ]);
  assert.deepEqual(ordered.map(account => account.id), ["s1", "s2", "m1", "m2"]);
});

test("apenas ML continua funcionando", () => {
  const ordered = orderMarketplaceAccounts([{ id: "m1", marketplace: "mercado_livre" }]);
  assert.deepEqual(ordered.map(account => account.id), ["m1"]);
});

test("apenas Shopee continua funcionando", () => {
  const ordered = orderMarketplaceAccounts([{ id: "s1", marketplace: "shopee" }]);
  assert.deepEqual(ordered.map(account => account.id), ["s1"]);
});

test("original selecionada disponivel evita recuperacao de marketplaces", () => {
  assert.match(temporaryRecoverySource, /imageIsAvailable\(productImageUrl\(image\)\)/);
  assert.ok(temporaryRecoverySource.indexOf("if (currentImages.length && !unavailablePositions.length) return null;") < temporaryRecoverySource.indexOf('from("product_marketplaces")'));
});

test("falha ou ausencia de imagem Shopee cai para ML e nenhuma fonte preserva o fallback", () => {
  assert.match(temporaryRecoverySource, /if \(!urls\.length\) continue;/);
  assert.match(temporaryRecoverySource, /catch \{[\s\S]*tentar a proxima conta vinculada/);
  assert.match(temporaryRecoverySource, /return null;\s*\}/);
});

test("preserva a ordem da primeira origem e remove apenas URLs repetidas", () => {
  const urls = extractMarketplaceImageUrls({ pictures: [
    { secure_url: "http://img/3.jpg" }, { secure_url: "https://img/1.jpg" },
    { secure_url: "https://img/2.jpg" }, { secure_url: "https://img/1.jpg" }
  ] });
  assert.deepEqual(urls, ["https://img/3.jpg", "https://img/1.jpg", "https://img/2.jpg"]);
});

test("Mercado Livre escolhe a maior variacao pelos metadados", () => {
  const selected = selectBestMercadoLivrePictureUrl({ variations: [
    { size: "500x280", secure_url: "https://http2.mlstatic.com/D_NQ_NP_123-MLB456-O.jpg" },
    { size: "1200x672", secure_url: "https://http2.mlstatic.com/D_NQ_NP_123-MLB456-F.jpg" },
    { size: "400x400", secure_url: "https://http2.mlstatic.com/D_NQ_NP_123-MLB456-C.jpg" }
  ] });
  assert.equal(selected, "https://http2.mlstatic.com/D_NQ_NP_123-MLB456-F.jpg");
});

test("Mercado Livre troca thumbnail O pela versao maxima F", () => {
  const selected = selectBestMercadoLivrePictureUrl({
    secure_url: "https://http2.mlstatic.com/D_938331-MLB45268824993_032021-O.jpg",
    size: "500x341",
    max_size: "1200x820"
  });
  assert.equal(selected, "https://http2.mlstatic.com/D_938331-MLB45268824993_032021-F.jpg");
});

test("Mercado Livre desempata URLs sem dimensao pela semantica oficial F", () => {
  const selected = selectBestMercadoLivrePictureUrl({ variations: [
    { secure_url: "https://http2.mlstatic.com/D_NQ_NP_123-MLB456-O.jpg" },
    { secure_url: "https://http2.mlstatic.com/D_NQ_NP_123-MLB456-F.jpg" }
  ] });
  assert.equal(selected, "https://http2.mlstatic.com/D_NQ_NP_123-MLB456-F.jpg");
});

test("Mercado Livre preserva versao pequena quando ela e a unica resolucao real", () => {
  const selected = selectBestMercadoLivrePictureUrl({
    secure_url: "https://http2.mlstatic.com/D_123-MLB456-O.jpg",
    size: "320x240",
    max_size: "320x240"
  });
  assert.equal(selected, "https://http2.mlstatic.com/D_123-MLB456-O.jpg");
  assert.deepEqual(validateMarketplaceImage({ width: 320, height: 240, bytes: 50_000 }), [
    "Tamanho mínimo: pelo menos um dos lados deve ter 500 px."
  ]);
});

test("Mercado Livre preserva ordem das fotos e ignora entradas invalidas", () => {
  const urls = extractMercadoLivreImageUrls({ pictures: [
    { secure_url: "https://http2.mlstatic.com/D_1-MLB1-O.jpg", size: "500x400", max_size: "1200x960" },
    { secure_url: "javascript:alert(1)" },
    { variations: [{ size: "800x600", secure_url: "https://http2.mlstatic.com/D_2-MLB2-F.jpg" }] }
  ] });
  assert.deepEqual(urls, [
    "https://http2.mlstatic.com/D_1-MLB1-F.jpg",
    "https://http2.mlstatic.com/D_2-MLB2-F.jpg"
  ]);
});

test("Shopee continua usando o extrator generico sem reescrever URL", () => {
  const url = "https://cf.shopee.com.br/file/photo-1";
  assert.deepEqual(extractMarketplaceImageUrls({ image: { image_url_list: [url] } }), [url]);
});

test("nenhuma imagem valida preserva o fallback vazio", () => {
  assert.deepEqual(extractMercadoLivreImageUrls({ pictures: [{ secure_url: "data:image/jpeg;base64,abc" }, {}] }), []);
});

test("recuperacao automatica persiste somente no produto e nao altera anuncio", () => {
  assert.match(recoverySource, /from\("product_images"\)\.insert/);
  assert.doesNotMatch(recoverySource, /updateMercadoLivre|updateShopee|enqueueOutgoingActivity|enqueueDirectListingUpdates/);
});
