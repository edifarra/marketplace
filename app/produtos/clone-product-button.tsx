"use client";

import { cloneProductAction } from "./actions";
import { ProductActionSubmit } from "./product-action-submit";

export function CloneProductButton({ productId, returnTo = "/produtos" }: { productId: string; returnTo?: string }) {
  return <form action={cloneProductAction}>
    <input type="hidden" name="productId" value={productId} />
    <input type="hidden" name="returnTo" value={returnTo} />
    <CloneSubmit />
  </form>;
}

function CloneSubmit() {
  return <ProductActionSubmit label="Clonar" pendingLabel="Clonando" />;
}
