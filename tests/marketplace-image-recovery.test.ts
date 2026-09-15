import assert from "node:assert/strict";
import test from "node:test";
import { extractMarketplaceImageUrls } from "../lib/marketplace-image-recovery";
import { orderMarketplaceAccounts } from "../lib/marketplace-temporary-images";

test("prioriza as duas contas ML e depois as duas contas Shopee", () => {
  const ordered = orderMarketplaceAccounts([
    { id: "s2", marketplace: "shopee", name: "Shopee 2", created_at: "2025-04-01" },
    { id: "m2", marketplace: "mercado_livre", name: "Mercado Livre 2", created_at: "2025-02-01" },
    { id: "s1", marketplace: "shopee", name: "Shopee 1", created_at: "2025-03-01" },
    { id: "m1", marketplace: "mercado_livre", name: "Mercado Livre 1", created_at: "2025-01-01" }
  ]);
  assert.deepEqual(ordered.map(account => account.id), ["m1", "m2", "s1", "s2"]);
});

test("preserva a ordem da primeira origem e remove apenas URLs repetidas", () => {
  const urls = extractMarketplaceImageUrls({ pictures: [
    { secure_url: "http://img/3.jpg" }, { secure_url: "https://img/1.jpg" },
    { secure_url: "https://img/2.jpg" }, { secure_url: "https://img/1.jpg" }
  ] });
  assert.deepEqual(urls, ["https://img/3.jpg", "https://img/1.jpg", "https://img/2.jpg"]);
});
