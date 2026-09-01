import assert from "node:assert/strict";
import { normalizeMercadoLivrePackageAttributes } from "../lib/effective-product";

const result = normalizeMercadoLivrePackageAttributes([
  { id: "BRAND", value_name: "Philips" },
  { id: "SELLER_PACKAGE_WIDTH", value_name: "25" },
  { id: "SELLER_PACKAGE_HEIGHT", value_name: "5.2" },
  { id: "SELLER_PACKAGE_LENGTH", value_name: "20" },
  { id: "SELLER_PACKAGE_WEIGHT", value_name: "0.4" }
], { width: 25, height: 5.2, length: 20, weight_gross: 0.4 } as any);

assert.deepEqual(result, [
  { id: "BRAND", value_name: "Philips" },
  { id: "SELLER_PACKAGE_WIDTH", value_name: "25 cm" },
  { id: "SELLER_PACKAGE_HEIGHT", value_name: "6 cm" },
  { id: "SELLER_PACKAGE_LENGTH", value_name: "20 cm" },
  { id: "SELLER_PACKAGE_WEIGHT", value_name: "400 g" }
]);

console.log("Mercado Livre package attribute normalization: OK");
