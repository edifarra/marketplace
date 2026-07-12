"use client";

import { useState } from "react";
import { linkMarketplaceSkuAction } from "./actions";

export function LinkMarketplaceButton({ sku, status }: { sku: string; status: string }) {
  const [open, setOpen] = useState(false);
  return <>
    <button className="secondary compact" type="button" onClick={() => setOpen(true)}>Vincular</button>
    {open && <div className="modal-backdrop" role="presentation" onMouseDown={() => setOpen(false)}>
      <section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="link-listing-title" onMouseDown={(event) => event.stopPropagation()}>
        <h3 id="link-listing-title">Vincular anuncio</h3>
        <p>Informe o SKU de um produto ja cadastrado no sistema. O anuncio <strong>{sku}</strong> passara a ser rastreado por esse produto.</p>
        <form action={linkMarketplaceSkuAction}>
          <input type="hidden" name="sku" value={sku} />
          <input type="hidden" name="status" value={status} />
          <label>SKU do produto</label>
          <input name="targetSku" required autoFocus placeholder="Ex.: VD24" />
          <div className="form-actions">
            <button className="secondary" type="button" onClick={() => setOpen(false)}>Cancelar</button>
            <button className="primary" type="submit">Confirmar vinculo</button>
          </div>
        </form>
      </section>
    </div>}
  </>;
}
