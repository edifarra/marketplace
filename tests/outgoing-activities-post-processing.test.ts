import assert from "node:assert/strict";
import test from "node:test";
import { postProcessMarketplaceConfirmation } from "../lib/outgoing-activities";

type Call = { table: string; operation: "update"; values: Record<string, unknown>; filters: Array<[string, unknown]> };

function fakeDb(errorTable?: string) {
  const calls: Call[] = [];
  return {
    calls,
    client: {
      from(table: string) {
        return {
          update(values: Record<string, unknown>) {
            const call: Call = { table, operation: "update", values, filters: [] };
            calls.push(call);
            const builder = {
              eq(column: string, value: unknown) {
                call.filters.push([column, value]);
                return builder;
              },
              async throwOnError() {
                if (table === errorTable) throw new Error(`Falha esperada em ${table}`);
                return { data: null, error: null };
              }
            };
            return builder;
          }
        };
      }
    }
  };
}

test("Tiny conclui o pos-processamento sem tocar tabelas de marketplace ou criar eq.null", async () => {
  const db = fakeDb();
  await postProcessMarketplaceConfirmation(db.client as never, {
    destination: "tiny", activity_type: "stock_update", marketplace_account_id: null, listing_id: "123"
  }, { stock: 2, status: "active" });

  assert.deepEqual(db.calls, []);
});

for (const destination of ["mercado_livre", "shopee"] as const) {
  test(`${destination} mantem o pos-processamento de stock_update`, async () => {
    const db = fakeDb();
    await postProcessMarketplaceConfirmation(db.client as never, {
      destination, activity_type: "stock_update", marketplace_account_id: "account-id", listing_id: "listing-id"
    }, { stock: 3, status: "active" });

    assert.deepEqual(db.calls.map(call => call.table), ["listings", "product_marketplaces"]);
    for (const call of db.calls) {
      assert.ok(call.filters.some(([column, value]) => column === "marketplace_account_id" && value === "account-id"));
      assert.ok(call.filters.every(([, value]) => value !== null));
    }
  });
}

test("erro em escrita esperada de marketplace nao e ignorado", async () => {
  const db = fakeDb("product_marketplaces");
  await assert.rejects(
    postProcessMarketplaceConfirmation(db.client as never, {
      destination: "shopee", activity_type: "stock_update", marketplace_account_id: "account-id", listing_id: "listing-id"
    }, { stock: 1, status: "active" }),
    /Falha esperada em product_marketplaces/
  );
});

test("atividade de marketplace sem conta falha antes de construir filtro UUID", async () => {
  const db = fakeDb();
  await assert.rejects(
    postProcessMarketplaceConfirmation(db.client as never, {
      destination: "mercado_livre", activity_type: "listing_update", marketplace_account_id: null, listing_id: "listing-id"
    }, { stock: 1, status: "active" }),
    /Conta do marketplace ausente/
  );
  assert.deepEqual(db.calls, []);
});
