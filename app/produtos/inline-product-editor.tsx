"use client";
import { useRef } from "react";
import { updateProductInlineAction } from "./actions";

export function InlineProductEditor({ product }: { product: { id: string; title: string; price: number; physical: number; canEditTitle: boolean } }) {
  const stockRef = useRef<HTMLInputElement>(null);
  const change = (delta: number) => { if (stockRef.current) stockRef.current.value = String(Math.max(0, Number(stockRef.current.value || 0) + delta)); };
  return <form action={updateProductInlineAction} className="inline-edit-form">
    <input type="hidden" name="productId" value={product.id} />
    <input name="title" defaultValue={product.title} readOnly={!product.canEditTitle} title={product.canEditTitle ? "Titulo editavel" : "Bloqueado: produto vinculado a marketplace"} />
    <input name="price" type="number" min="0" step="0.01" defaultValue={product.price} />
    <span className="stock-cell"><button type="button" className="secondary compact" onClick={() => change(-1)}>-</button><input ref={stockRef} name="stock" type="number" min="0" step="1" defaultValue={product.physical} /><button type="button" className="secondary compact" onClick={() => change(1)}>+</button></span>
    <button className="secondary compact" type="submit">Salvar</button>
  </form>;
}
