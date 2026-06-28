"use client";

import { deleteProductAction } from "./actions";

export function DeleteProductButton({ productId }: { productId: string }) {
  return (
    <form
      action={deleteProductAction}
      onSubmit={(event) => {
        const confirmed = window.confirm(
          "Ao excluir este produto, todas as imagens locais e hospedadas serao excluidas. Anuncios publicados tambem serao removidos em uma proxima etapa. Deseja continuar?"
        );

        if (!confirmed) {
          event.preventDefault();
        }
      }}
    >
      <input type="hidden" name="productId" value={productId} />
      <button className="danger compact" type="submit">Excluir</button>
    </form>
  );
}
