"use client";

import { useState } from "react";
import { removeProductIntegrationAction } from "../actions";

type IntegrationDeleteButtonProps = {
  productId: string;
  integration: string;
  externalId?: string;
  accountId?: string;
};

export function IntegrationDeleteButton({ productId, integration, externalId = "", accountId = "" }: IntegrationDeleteButtonProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button className="danger compact" type="button" onClick={() => setOpen(true)}>Excluir</button>
      {open && (
        <div className="modal-backdrop" role="presentation">
          <div className="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="delete-integration-title">
            <h3 id="delete-integration-title">Excluir integracao</h3>
            <p>Deseja excluir tambem no ambiente externo?</p>
            <div className="form-actions">
              <button className="secondary" type="button" onClick={() => setOpen(false)}>Cancelar</button>
              <IntegrationDeleteForm productId={productId} integration={integration} externalId={externalId} accountId={accountId} deleteExternal={false} label="Nao" />
              <IntegrationDeleteForm productId={productId} integration={integration} externalId={externalId} accountId={accountId} deleteExternal label="Sim" danger />
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function IntegrationDeleteForm({
  productId,
  integration,
  externalId,
  accountId,
  deleteExternal,
  label,
  danger = false
}: IntegrationDeleteButtonProps & { deleteExternal: boolean; label: string; danger?: boolean }) {
  return (
    <form action={removeProductIntegrationAction}>
      <input type="hidden" name="productId" value={productId} />
      <input type="hidden" name="integration" value={integration} />
      <input type="hidden" name="externalId" value={externalId || ""} />
      <input type="hidden" name="accountId" value={accountId || ""} />
      <input type="hidden" name="deleteExternal" value={deleteExternal ? "true" : "false"} />
      <button className={danger ? "danger" : "secondary"} type="submit">{label}</button>
    </form>
  );
}
