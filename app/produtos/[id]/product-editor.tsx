"use client";

import { useEffect, useRef, useState } from "react";
import { updateProductDetailsAction } from "../actions";

type Option = { code: string; label: string };
type ImageItem = { id: string; name: string; url: string; position: number };

export function ProductEditor({ product, types, brands, specials, images }: {
  product: Record<string, string | number | null>;
  types: Option[]; brands: Option[]; specials: Option[]; images: ImageItem[];
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [preview, setPreview] = useState("");
  const [dirty, setDirty] = useState(false);
  const [pendingHref, setPendingHref] = useState("");
  const [ordered, setOrdered] = useState([...images].sort((a, b) => a.position - b.position));
  const move = (index: number, delta: number) => setOrdered((current) => {
    const target = index + delta;
    if (target < 0 || target >= current.length) return current;
    const next = [...current];
    [next[index], next[target]] = [next[target], next[index]];
    setDirty(true); return next;
  });
  const remove = (id: string) => { setDirty(true); setOrdered((current) => current.filter((image) => image.id !== id)); };

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };
    const linkClick = (event: MouseEvent) => {
      if (!dirty || event.defaultPrevented || event.button !== 0) return;
      const anchor = (event.target as HTMLElement).closest("a[href]") as HTMLAnchorElement | null;
      if (!anchor || anchor.target === "_blank" || anchor.href === window.location.href || anchor.getAttribute("href")?.startsWith("#")) return;
      event.preventDefault(); setPendingHref(anchor.getAttribute("href") || anchor.href);
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", linkClick, true);
    return () => { window.removeEventListener("beforeunload", beforeUnload); document.removeEventListener("click", linkClick, true); };
  }, [dirty]);

  return <>
    <div className="topbar">
      <div><h1>{String(product.sku || "")}</h1><div className="subtitle">{String(product.title || "")}</div></div>
      <div className="row-actions">
        <a className="secondary" href={`/historico-estoque?produto=${product.id}`}>Histórico de Estoque</a>
        <button className="primary" form="product-detail-form" type="submit" disabled={!dirty}>Atualizar</button>
        <a className="secondary" href="/produtos">Voltar</a>
      </div>
    </div>
  <form ref={formRef} id="product-detail-form" action={updateProductDetailsAction} className="product-detail-edit-form" onChange={() => setDirty(true)} onSubmit={() => setDirty(false)}>
    <input type="hidden" name="productId" value={String(product.id)} />
    <input type="hidden" name="imageOrder" value={ordered.map((image) => image.id).join(",")} />
    <input type="hidden" name="redirectTo" value={pendingHref} />
    <section className="grid detail-grid">
      <div className="card detail-edit-card"><h2>Produto</h2>
        <label>SKU<input name="sku" required defaultValue={String(product.sku || "")} /></label>
        <label>Título<input name="title" required defaultValue={String(product.title || "")} /></label>
        <label>Tipo de Placa<select name="typeCode" defaultValue={String(product.type_code || "")}>{types.map(o => <option key={o.code} value={o.code}>{o.label}</option>)}</select></label>
        <label>Marca<select name="brandCode" defaultValue={String(product.brand_code || "")}>{brands.map(o => <option key={o.code} value={o.code}>{o.label}</option>)}</select></label>
        <label>Especial<select name="specialCode" defaultValue={String(product.special_code || "")}><option value="">Sem especial</option>{specials.map(o => <option key={o.code} value={o.code}>{o.label}</option>)}</select></label>
      </div>
      <div className="card detail-edit-card"><h2>Referências</h2>
        <label>Largura (cm)<input name="width" type="number" min="0" step="0.01" required defaultValue={String(product.width ?? "")} /></label>
        <label>Altura (cm)<input name="height" type="number" min="0" step="0.01" required defaultValue={String(product.height ?? "")} /></label>
        <label>Comprimento (cm)<input name="length" type="number" min="0" step="0.01" required defaultValue={String(product.length ?? "")} /></label>
        <label>Peso líquido (kg)<input name="weightNet" type="number" min="0" step="0.001" required defaultValue={String(product.weight_net ?? "")} /></label>
        <label>Peso bruto (kg)<input name="weightGross" type="number" min="0" step="0.001" required defaultValue={String(product.weight_gross ?? "")} /></label>
      </div>
    </section>
    <section className="section card"><h2>Descrição</h2><textarea className="detail-description-input" name="description" rows={9} required defaultValue={String(product.description || "")} /></section>

    <section className="section card"><div className="editor-images-heading"><div><h2>Imagens</h2><span>A primeira imagem sempre será enviada como Foto 01.</span></div><button className="secondary" type="button" onClick={() => inputRef.current?.click()}>Adicionar imagens</button></div>
    <input ref={inputRef} className="visually-hidden" type="file" name="newImages" accept="image/jpeg,image/png,image/webp" multiple />
    <div className="editable-image-grid">
      {ordered.map((image, index) => <figure className="editable-product-image" key={image.id}>
        <button type="button" className="image-preview-button" onClick={() => setPreview(image.url)}><img src={image.url} alt={image.name} /></button>
        {index === 0 && <strong className="cover-badge">Foto da Capa</strong>}
        <button type="button" className="image-trash" aria-label={`Excluir ${image.name}`} onClick={() => remove(image.id)}>🗑</button>
        <figcaption><button type="button" disabled={index === 0} onClick={() => move(index, -1)}>←</button><span>{String(index + 1).padStart(2, "0")}</span><button type="button" disabled={index === ordered.length - 1} onClick={() => move(index, 1)}>→</button></figcaption>
      </figure>)}
    </div></section>
    {preview && <button type="button" className="image-preview-modal" onClick={() => setPreview("")}><img src={preview} alt="Visualização ampliada" /></button>}
  </form>
  {pendingHref && <div className="modal-backdrop"><div className="confirm-modal"><h3>Atualizações não salvas no produto.</h3><p>Deseja salvar antes de sair?</p><div className="modal-actions"><button type="button" className="secondary" onClick={() => { const href = pendingHref; setDirty(false); setPendingHref(""); window.location.href = href; }}>Não</button><button type="button" className="primary" onClick={() => { setDirty(false); formRef.current?.requestSubmit(); }}>Sim</button></div></div></div>}
  </>;
}
