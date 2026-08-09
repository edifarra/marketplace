"use client";

import { useState, useTransition } from "react";
import type { ProductDeletionInspection } from "@/lib/products";
import { deleteProductAction, inspectProductDeletionAction } from "./actions";

export function DeleteProductButton({ productId }: { productId: string }) {
  const [open, setOpen] = useState(false);
  const [inspection, setInspection] = useState<ProductDeletionInspection | null>(null);
  const [checking, startChecking] = useTransition();

  const inspect = (recheck = false) => {
    setOpen(true);
    setInspection(null);
    startChecking(async () => {
      try {
        const result = await inspectProductDeletionAction(productId, recheck);
        setInspection(result.status === "tiny_ads" && recheck
          ? { ...result, message: `Ainda existem ${result.tinyAdCount} anuncio(s) vinculado(s) no Tiny. Remova-os antes de continuar.` }
          : result);
      } catch (error) {
        setInspection({ status: "error", message: error instanceof Error ? error.message : "Falha ao validar o produto." });
      }
    });
  };

  return (
    <>
      <button className="danger compact" type="button" onClick={() => inspect()}>Excluir</button>
      {open && (
        <div className="modal-backdrop" role="presentation">
          <section className="confirm-modal" role="dialog" aria-modal="true" aria-labelledby={`delete-product-${productId}`}>
            <h3 id={`delete-product-${productId}`}>Excluir produto</h3>
            {checking && <p>Validando estoque e integracoes...</p>}
            {!checking && inspection?.status === "stock_mismatch" && (
              <><div className="form-error">{inspection.message}</div><ModalClose onClose={() => setOpen(false)} /></>
            )}
            {!checking && inspection?.status === "error" && (
              <>
                <div className="form-error">{inspection.message}</div>
                {inspection.tinyProductUrl && <p><a className="secondary link-button" href={inspection.tinyProductUrl} target="_blank" rel="noreferrer">Abrir anuncios do produto no Tiny</a></p>}
                <ModalClose onClose={() => setOpen(false)} />
              </>
            )}
            {!checking && inspection?.status === "tiny_ads" && (
              <>
                <p>{inspection.message}</p>
                {inspection.tinyProductUrl && <p><a className="secondary link-button" href={inspection.tinyProductUrl} target="_blank" rel="noreferrer">Abrir anuncios do produto no Tiny</a></p>}
                <p>Depois da remocao manual, escolha uma opcao:</p>
                <div className="modal-actions">
                  <button className="primary" type="button" onClick={() => inspect(true)}>Sim, removi os anuncios</button>
                  <button className="secondary" type="button" onClick={() => setOpen(false)}>Nao, farei mais tarde</button>
                </div>
              </>
            )}
            {!checking && inspection?.status === "ready" && (
              <>
                <p>A remocao ira apagar:</p>
                <ul>
                  <li>Anuncios nos marketplaces.</li>
                  <li>Fotos hospedadas no Cloudinary.</li>
                  <li>O produto no sistema.</li>
                </ul>
                <p><strong>Atencao:</strong> essa acao nao remove vendas realizadas anteriormente com este produto.</p>
                {inspection.tinyProductMissing && <div className="form-error">O produto nao foi encontrado no Tiny e, por isso, nao sera inativado.</div>}
                <div className="modal-actions">
                  <form action={deleteProductAction}>
                    <input type="hidden" name="productId" value={productId} />
                    <input type="hidden" name="tinyAdsRemoved" value="true" />
                    <button className="danger" type="submit">Aceitar e excluir</button>
                  </form>
                  <button className="secondary" type="button" onClick={() => setOpen(false)}>Cancelar</button>
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </>
  );
}

function ModalClose({ onClose }: { onClose: () => void }) {
  return <div className="modal-actions"><button className="secondary" type="button" onClick={onClose}>Fechar</button></div>;
}
