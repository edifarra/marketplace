"use client";

import { useFormStatus } from "react-dom";
import { synchronizeStockSkuAction } from "./actions";

export function SynchronizeSkuButton({ sku, view }: { sku: string; view: string }) {
  return (
    <form action={synchronizeStockSkuAction}>
      <input type="hidden" name="sku" value={sku} />
      <input type="hidden" name="view" value={view} />
      <SubmitButton />
    </form>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button className={`secondary compact product-sync-button${pending ? " syncing" : ""}`} type="submit" disabled={pending} aria-busy={pending}>
      {pending ? <><span>Sincronizando</span><span className="syncing-dots" aria-hidden="true"><i /><i /><i /></span></> : "Sincronizar"}
    </button>
  );
}
