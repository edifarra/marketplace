import assert from "node:assert/strict";
import { fetchMercadoLivreLastModeration } from "../lib/mercado-livre";
import { shouldFetchMercadoLivreModeration } from "../lib/marketplace-queue-worker";

async function main() {
  const accountToken = "test-token-never-sent";

  assert.equal(shouldFetchMercadoLivreModeration({
    status: "paused",
    sub_status: ["paused_by_seller", "out_of_stock"]
  }), false, "pausa sem sinal de moderacao nao deve consultar last_moderation");

  const moderation = [{ id: "mod-1", wordings: [{ type: "REASON", value: "Motivo" }] }];
  assert.equal(shouldFetchMercadoLivreModeration({ status: "under_review", sub_status: ["waiting_for_patch"] }), true);
  assert.deepEqual(await fetchMercadoLivreLastModeration("MLB123", accountToken, async () => new Response(
    JSON.stringify(moderation), { status: 200, headers: { "content-type": "application/json" } }
  )), moderation, "item under_review deve obter a moderacao que sera persistida pelo worker");

  assert.deepEqual(await fetchMercadoLivreLastModeration("MLB404", accountToken, async () => new Response(
    JSON.stringify({ Status: 404 }), { status: 404, headers: { "content-type": "application/json" } }
  )), [], "404 de last_moderation deve representar ausencia de moderacao");

  for (const status of [429, 500, 503]) {
    await assert.rejects(
      fetchMercadoLivreLastModeration("MLBRETRY", accountToken, async () => new Response(
        JSON.stringify({ status }), { status, headers: { "content-type": "application/json" } }
      )),
      new RegExp(`\\(${status}\\)`),
      `HTTP ${status} deve continuar propagando erro`
    );
  }

  console.log("Validacao de eventos items/moderacao do Mercado Livre concluida.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
