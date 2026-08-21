"use client";

import { synchronizeProductAction } from "./actions";
import { ProductActionSubmit } from "./product-action-submit";

export function SynchronizeProductButton({ productId, returnTo = "/produtos" }: { productId: string; returnTo?: string }) {
  return (
    <form action={synchronizeProductAction}>
      <input type="hidden" name="productId" value={productId} />
      <input type="hidden" name="returnTo" value={returnTo} />
      <SubmitButton />
    </form>
  );
}

function SubmitButton() {
  return <ProductActionSubmit label="Sincronizar" pendingLabel="Sincronizando" />;
}
