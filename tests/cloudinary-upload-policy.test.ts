import assert from "node:assert/strict";
import test from "node:test";
import {
  CLOUDINARY_MASTER_MAX_PX,
  CloudinaryRequestError,
  buildCloudinaryImageName,
  cloudinaryDirectDeliveryUrl,
  cloudinaryIncomingTransformation,
  deleteCloudinaryResourceWithAccounts,
  isCloudinaryQuotaOrBillingError,
  uploadProductImageWithAccount,
  withCloudinaryUploadFallback,
  type CloudinaryCredentials
} from "../lib/cloudinary";

test("URL persistida e a secure_url direta do asset armazenado", () => {
  const secureUrl = "https://res.cloudinary.com/conta/image/upload/v1/produtos/X/master.jpg";
  assert.equal(cloudinaryDirectDeliveryUrl({ secure_url: secureUrl }), secureUrl);
  assert.doesNotMatch(cloudinaryDirectDeliveryUrl({ secure_url: secureUrl }), /\/a_auto\/|\/c_limit,/);
});

test("foto 1 propria usa um unico master com orientacao e fundo branco", () => {
  assert.equal(CLOUDINARY_MASTER_MAX_PX, 1200);
  assert.equal(
    cloudinaryIncomingTransformation("owned", 1),
    "a_auto/e_background_removal,b_white/c_limit,w_1200,h_1200/q_auto:good,f_jpg"
  );
});

test("foto 2 propria nao remove fundo", () => {
  assert.equal(
    cloudinaryIncomingTransformation("owned", 2),
    "a_auto/c_limit,w_1200,h_1200/q_auto:good,f_jpg"
  );
});

test("foto 1 de marketplace aplica somente fundo branco, sem redimensionar ou recodificar", () => {
  assert.equal(cloudinaryIncomingTransformation("marketplace", 1), "e_background_removal,b_white");
});

test("fotos 2 a 6 de marketplace e masters clonados nao sao transformados", () => {
  assert.equal(cloudinaryIncomingTransformation("marketplace", 2), "");
  assert.equal(cloudinaryIncomingTransformation("marketplace", 6), "");
  assert.equal(cloudinaryIncomingTransformation("stored_master", 1), "");
});

test("nome base do public_id independe da posicao", () => {
  const common = { sku: "ABC1", typeCode: "TV", model: "Modelo X", boardCode: "P123" };
  assert.equal(buildCloudinaryImageName({ ...common, position: 1 }), buildCloudinaryImageName({ ...common, position: 6 }));
  assert.equal(buildCloudinaryImageName(common), "ABC1TV_MODELO_X_P123");
});

test("fallback reconhece status e codigo estruturado de quota", () => {
  assert.equal(isCloudinaryQuotaOrBillingError(new CloudinaryRequestError("rate limited", 420)), true);
  assert.equal(isCloudinaryQuotaOrBillingError(new CloudinaryRequestError("generic", 429)), true);
  assert.equal(isCloudinaryQuotaOrBillingError(new CloudinaryRequestError("generic", 400, "usage_limit")), true);
  assert.equal(isCloudinaryQuotaOrBillingError(new CloudinaryRequestError("invalid image", 400, "invalid_parameter")), false);
});

test("upload usa incoming transformation e devolve secure_url direta", async () => {
  const originalFetch = globalThis.fetch;
  let sentTransformation = "";
  globalThis.fetch = (async (_input, init) => {
    sentTransformation = String((init?.body as FormData).get("transformation") || "");
    return Response.json({ asset_id: "asset-1", public_id: "produtos/M/asset", secure_url: "https://res.cloudinary.com/main/image/upload/v1/produtos/M/asset.jpg", resource_type: "image", bytes: 150_000, width: 1200, height: 900 });
  }) as typeof fetch;
  try {
    const result = await uploadProductImageWithAccount({ buffer: Buffer.from("image"), fileName: "foto.jpg", sku: "1", typeCode: "TV", brandCode: "M", model: "X", position: 2, source: "owned" }, account("main", false));
    assert.equal(sentTransformation, "a_auto/c_limit,w_1200,h_1200/q_auto:good,f_jpg");
    assert.equal(result.cloudinaryUrl, "https://res.cloudinary.com/main/image/upload/v1/produtos/M/asset.jpg");
    assert.equal(result.assetId, "asset-1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fallback executa a reserva somente para erro de quota", async () => {
  const calls: string[] = [];
  const result = await withCloudinaryUploadFallback({ primary: account("main", false), reserve: account("reserve", true) }, async current => {
    calls.push(current.cloudName);
    if (!current.reserve) throw new CloudinaryRequestError("quota", 420);
    return current.cloudName;
  });
  assert.equal(result, "reserve");
  assert.deepEqual(calls, ["main", "reserve"]);
});

test("cloudName desconhecido nao usa a conta principal como fallback", async () => {
  const calls: string[] = [];
  const deleted = await deleteCloudinaryResourceWithAccounts("legacy::produtos/foto", { primary: account("main", false), reserve: account("reserve", true) }, async (_publicId, current) => {
    calls.push(current.cloudName);
  });
  assert.equal(deleted, false);
  assert.deepEqual(calls, []);
});

test("conta Cloudinary antiga desativada nao bloqueia o cleanup", async () => {
  const calls: string[] = [];
  const deleted = await deleteCloudinaryResourceWithAccounts("legacy::produtos/foto", { primary: account("main", false), reserve: account("legacy", true) }, async (_publicId, current) => {
    calls.push(current.cloudName);
    throw new CloudinaryRequestError("cloud_name is disabled", 401, "account_disabled");
  });
  assert.equal(deleted, false);
  assert.deepEqual(calls, ["legacy"]);
});

test("billing, quota e asset inexistente durante cleanup sao nao criticos", async () => {
  for (const message of ["billing limit", "quota exceeded", "Resource not found"]) {
    const deleted = await deleteCloudinaryResourceWithAccounts("main::produtos/foto", { primary: account("main", false), reserve: null }, async () => {
      throw new Error(message);
    });
    assert.equal(deleted, false);
  }
});

function account(cloudName: string, reserve: boolean): CloudinaryCredentials {
  return { cloudName, apiKey: "key", apiSecret: "secret", reserve };
}
