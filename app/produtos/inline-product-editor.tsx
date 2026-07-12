"use client";
import { useRef } from "react";
import { updateProductInlineAction } from "./actions";

export function InlineProductEditor({ product }: { product: { id: string; title: string; price: number; physical: number; available: number; canEditTitle: boolean } }) {
  const stockRef = useRef<HTMLInputElement>(null);
  const change = (delta: number) => { if (stockRef.current) stockRef.current.value = String(Math.max(0, Number(stockRef.current.value || 0) + delta)); };
  const formId = `product-edit-${product.id}`;
  return <>
    <td><form id={formId} action={updateProductInlineAction}><input type="hidden" name="productId" value={product.id} /></form><input form={formId} name="title" className="product-title-input" defaultValue={product.title} readOnly={!product.canEditTitle} title={product.canEditTitle ? "Titulo editavel" : "Bloqueado: produto vinculado a marketplace"} /></td>
    <td><input form={formId} name="price" className="product-price-input" type="number" min="0" step="0.01" defaultValue={product.price} /></td>
    <td><span className="stock-cell"><button type="button" className="stock-button" onClick={() => change(-1)}>-</button><input form={formId} ref={stockRef} name="stock" type="number" min="0" step="1" defaultValue={product.physical} /><button type="button" className="stock-button" onClick={() => change(1)}>+</button></span></td>
    <td>{product.available}</td>
  </>;
}
