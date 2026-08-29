"use client";

import { synchronizeProductAction } from "./actions";
import { ProductActionSubmit } from "./product-action-submit";

export function SynchronizeProductButton({ productId, returnTo = "/produtos", disabledReason }: { productId: string; returnTo?: string; disabledReason?: string }) {
  return (
    <form action={synchronizeProductAction}>
      <input type="hidden" name="productId" value={productId} />
      <input type="hidden" name="returnTo" value={returnTo} />
      <SubmitButton disabledReason={disabledReason} />
    </form>
  );
}

function SubmitButton({ disabledReason }: { disabledReason?: string }) {
  return <ProductActionSubmit label="Sincronizar" pendingLabel="Sincronizando" disabledReason={disabledReason} />;
}
