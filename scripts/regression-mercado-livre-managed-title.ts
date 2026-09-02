import assert from "node:assert/strict";
import { hasMercadoLivreFamily, pendingManagedTitleRecovery, prepareManagedTitleRetry } from "../lib/mercado-livre-managed-title";

const title = "Placa Principal Tv Qn55q90tdg Bn94-15253y Original";

assert.equal(hasMercadoLivreFamily({ family_id: "family-1" }), true);
assert.equal(hasMercadoLivreFamily({ raw_data: { family_name: "Family" } }), true);
assert.equal(hasMercadoLivreFamily({ user_product_id: "up-1" }), false);
assert.deepEqual(pendingManagedTitleRecovery(title, {
  familyId: "family-1", familyName: "Anterior", userProductId: "up-1"
}), {
  status: "pending", requestedTitle: title, familyId: "family-1", familyName: "Anterior", userProductId: "up-1"
});

const prepared = prepareManagedTitleRetry({
  payload: { title, price: 199, available_quantity: 1 }, description: "Descricao"
}, { familyId: "family-1", familyName: "Anterior", userProductId: "up-1" });
assert.equal(prepared?.managedTitleRecovery.requestedTitle, title);
assert.equal(prepared?.managedTitleRecovery.status, "pending");
assert.deepEqual(prepared?.payload, { price: 199, available_quantity: 1 });
assert.equal(prepared?.description, "Descricao");
assert.equal(prepareManagedTitleRetry(prepared!, { familyId: "family-1" }), null);
assert.throws(() => pendingManagedTitleRecovery(""), /Titulo solicitado ausente/);

console.log("Regressao de titulo gerenciado por Family: OK");
