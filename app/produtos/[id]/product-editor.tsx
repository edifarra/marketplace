"use client";

import { useEffect, useRef, useState } from "react";
import { updateProductDetailsAction } from "../actions";
import { PriceInput } from "../price-input";

type Option = { code: string; label: string; marketplaceCategory?: string };
type ImageItem = { id: string; name: string; url: string; position: number };
type CategoryMapping = { internal_category:string; mercado_livre_code?:string; mercado_livre_description?:string; shopee_code?:string; shopee_description?:string; attribute_definitions?:Record<string,any> };
type Marketplace = "mercado_livre" | "shopee";
type CategoryNode = { id: string; name: string; hasChildren: boolean };
type MarketplaceSelection = { code: string; description: string };
const marketplaceLabels: Record<Marketplace, string> = { mercado_livre: "Mercado Livre", shopee: "Shopee" };

export function ProductEditor({ product, types, brands, specials, images, categoryMappings, marketplaceLinks, returnTo }: {
  product: Record<string, string | number | null>;
  types: Option[]; brands: Option[]; specials: Option[]; images: ImageItem[]; categoryMappings: CategoryMapping[];
  marketplaceLinks: Record<Marketplace, boolean>;
  returnTo: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [preview, setPreview] = useState("");
  const [newImagePreviews, setNewImagePreviews] = useState<Array<{ name: string; url: string }>>([]);
  const [validationAttempted, setValidationAttempted] = useState(false);
  const [title, setTitle] = useState(String(product.title || ""));
  const [brandCode, setBrandCode] = useState(String(product.brand_code || ""));
  const [physicalStock, setPhysicalStock] = useState(Number(product.estoque_fisico || 0));
  const availableStock = Number(product.estoque_disponivel || 0);
  const [dirty, setDirty] = useState(false);
  const [pendingHref, setPendingHref] = useState("");
  const [ordered, setOrdered] = useState([...images].sort((a, b) => a.position - b.position));
  const storedCategories = (product.marketplace_categories || {}) as unknown as Record<string,any>;
  const storedAttributes = (product.marketplace_attributes || {}) as unknown as Record<string,any>;
  const [typeCode, setTypeCode] = useState(String(product.type_code || ""));
  const [category, setCategory] = useState(String(storedCategories.internal_category || ""));
  const mapping = categoryMappings.find(item => item.internal_category === category);
  const [marketplaceCategories, setMarketplaceCategories] = useState<Record<Marketplace, MarketplaceSelection>>({
    mercado_livre: { code: String(storedCategories.mercado_livre?.categoryId || mapping?.mercado_livre_code || ""), description: String(storedCategories.mercado_livre?.categoryName || mapping?.mercado_livre_description || "") },
    shopee: { code: String(storedCategories.shopee?.categoryId || mapping?.shopee_code || ""), description: String(storedCategories.shopee?.categoryName || mapping?.shopee_description || "") }
  });
  const [picker, setPicker] = useState<Marketplace | null>(null);
  const [nodes, setNodes] = useState<CategoryNode[]>([]);
  const [trail, setTrail] = useState<Array<{ id: string; name: string }>>([]);
  const [categoryQuery, setCategoryQuery] = useState("");
  const [categoryError, setCategoryError] = useState("");
  const [categoryLoading, setCategoryLoading] = useState(false);
  const visibleNodes = nodes.filter(node => `${node.id} ${node.name}`.toLowerCase().includes(categoryQuery.toLowerCase()));
  const validation = {
    title: title.trim().length > 0 && title.trim().length <= 60,
    type: Boolean(typeCode) && typeCode !== "OT",
    brand: Boolean(brandCode) && brandCode !== "NI",
    cover: ordered.length + newImagePreviews.length > 0
  };
  const hasRequiredErrors = Object.values(validation).some(valid => !valid);

  async function loadCategories(marketplace: Marketplace, parent?: string, nextTrail: Array<{ id: string; name: string }> = []) {
    setCategoryLoading(true); setCategoryError(""); setPicker(marketplace); setCategoryQuery("");
    try {
      const response = await fetch(`/api/marketplace-categories/${marketplace}${parent ? `?parent=${encodeURIComponent(parent)}` : ""}`);
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || "Falha ao buscar categorias.");
      setNodes(json.nodes || []); setTrail(nextTrail);
    } catch (error) {
      setCategoryError(error instanceof Error ? error.message : String(error)); setNodes([]);
    } finally { setCategoryLoading(false); }
  }
  function chooseMarketplaceCategory(node: CategoryNode) {
    if (!picker) return;
    const description = [...trail, { id: node.id, name: node.name }].map(item => item.name).join(" > ");
    setMarketplaceCategories(current => ({ ...current, [picker]: { code: node.id, description } }));
    setPicker(null); setDirty(true);
  }
  function applyType(nextTypeCode: string) {
    setTypeCode(nextTypeCode); setDirty(true);
    const nextInternal = types.find(item => item.code === nextTypeCode)?.marketplaceCategory || "";
    if (nextTypeCode !== "OT") setCategory(nextInternal);
    const nextMapping = categoryMappings.find(item => item.internal_category === nextInternal);
    setMarketplaceCategories(current => ({
      mercado_livre: marketplaceLinks.mercado_livre ? current.mercado_livre : { code: String(nextMapping?.mercado_livre_code || ""), description: String(nextMapping?.mercado_livre_description || "") },
      shopee: marketplaceLinks.shopee ? current.shopee : { code: String(nextMapping?.shopee_code || ""), description: String(nextMapping?.shopee_description || "") }
    }));
  }
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

  useEffect(() => () => {
    for (const image of newImagePreviews) URL.revokeObjectURL(image.url);
  }, [newImagePreviews]);

  return <>
    <div className="topbar">
      <div><h1>{String(product.sku || "")}</h1><div className="subtitle">{String(product.title || "")}</div></div>
      <div className="row-actions">
        <a className="secondary" href={`/historico-estoque?produto=${product.id}`}>Histórico de Estoque</a>
        <button className="primary" form="product-detail-form" type="submit" disabled={!dirty}>Atualizar</button>
        <a className="secondary" href={returnTo}>Voltar</a>
      </div>
    </div>
  <form ref={formRef} id="product-detail-form" action={updateProductDetailsAction} className={`product-detail-edit-form${validationAttempted ? " validation-attempted" : ""}`} onInvalid={() => setValidationAttempted(true)} onChange={() => setDirty(true)} onSubmit={(event) => {
    setValidationAttempted(true);
    if (hasRequiredErrors) { event.preventDefault(); requestAnimationFrame(() => document.querySelector(".required-field-error")?.scrollIntoView({ behavior: "smooth", block: "center" })); return; }
    setDirty(false);
  }}>
    <input type="hidden" name="productId" value={String(product.id)} />
    <input type="hidden" name="returnTo" value={returnTo} />
    <input type="hidden" name="imageOrder" value={ordered.map((image) => image.id).join(",")} />
    <input type="hidden" name="redirectTo" value={pendingHref} />
    <section className="grid detail-grid">
      <div className="card detail-edit-card"><h2>Produto</h2>
        <label>SKU<input name="sku" required defaultValue={String(product.sku || "")} /></label>
        <label className={validationAttempted && !validation.title ? "required-field-error" : ""}>Título<span className="detail-title-field"><input name="title" required maxLength={60} value={title} onChange={event => setTitle(event.target.value)} /><span className={`title-character-count${title.length > 60 ? " over-limit" : ""}`}>{title.length}</span></span>{validationAttempted && !validation.title && <small className="required-field-message">Preencha o título com até 60 caracteres.</small>}</label>
        <label className={validationAttempted && !validation.type ? "required-field-error" : ""}>Tipo de Placa<select name="typeCode" value={typeCode} onChange={event => applyType(event.target.value)}>{types.map(o => <option key={o.code} value={o.code}>{o.label}</option>)}</select>{validationAttempted && !validation.type && <small className="required-field-message">Preencha o campo obrigatório. “OT - Outros” não é permitido.</small>}</label>
        <label className={validationAttempted && !validation.brand ? "required-field-error" : ""}>Marca<select name="brandCode" value={brandCode} onChange={event => { setBrandCode(event.target.value); setDirty(true); }}>{brands.map(o => <option key={o.code} value={o.code}>{o.label}</option>)}</select>{validationAttempted && !validation.brand && <small className="required-field-message">Preencha o campo obrigatório. “NI - Não informada” não é permitido.</small>}</label>
        <label>Especial<select name="specialCode" defaultValue={String(product.special_code || "")}><option value="">Sem especial</option>{specials.map(o => <option key={o.code} value={o.code}>{o.label}</option>)}</select></label>
        <label>Condição<select name="productCondition" defaultValue={String(product.product_condition || "used")}><option value="used">Usado</option><option value="new">Novo</option></select></label>
      </div>
      <div className="detail-right-column">
      <div className="card detail-edit-card product-value-stock-card"><h2>Valor e estoque</h2>
        <label>Valor do Produto (R$)<PriceInput initialValue={Number(product.price || 0)} required /></label>
        <QuantityControl label="Estoque físico" name="physicalStock" value={physicalStock} setValue={setPhysicalStock} onDirty={() => setDirty(true)} />
        <label>Estoque disponível<span className="available-stock-value" title="Calculado automaticamente pelo estoque físico menos as vendas consolidadas">{availableStock}</span></label>
      </div>
      <div className="card detail-edit-card"><h2>Referências</h2>
        <label>Largura (cm)<input name="width" type="number" min="0" step="0.01" required defaultValue={String(product.width ?? "")} /></label>
        <label>Altura (cm)<input name="height" type="number" min="0" step="0.01" required defaultValue={String(product.height ?? "")} /></label>
        <label>Comprimento (cm)<input name="length" type="number" min="0" step="0.01" required defaultValue={String(product.length ?? "")} /></label>
        <label>Peso líquido (kg)<input name="weightNet" type="number" min="0" step="0.001" required defaultValue={String(product.weight_net ?? "")} /></label>
        <label>Peso bruto (kg)<input name="weightGross" type="number" min="0" step="0.001" required defaultValue={String(product.weight_gross ?? "")} /></label>
      </div>
      </div>
    </section>
    <section className="section card"><h2>Descrição</h2><textarea className="detail-description-input" name="description" rows={9} required defaultValue={String(product.description || "")} /></section>
    <section className="section card"><h2>Categorias e atributos dos marketplaces</h2>
      <label>Categoria Interna<select name="marketplaceCategory" value={category} disabled={typeCode !== "OT"} onChange={event => { setCategory(event.target.value); setDirty(true); }}><option value="">Sem categoria</option>{categoryMappings.map(item => <option key={item.internal_category} value={item.internal_category}>{item.internal_category}</option>)}</select></label>
      {typeCode !== "OT" && <><input type="hidden" name="marketplaceCategory" value={category}/><p className="muted">A categoria interna é definida pelo tipo do produto. Para o tipo OT, ela pode ser escolhida.</p></>}
      <div className="category-marketplace-list product-marketplace-category-list">
        {(["mercado_livre", "shopee"] as Marketplace[]).map(marketplace => <div className="category-marketplace-row" key={marketplace}>
          <div className={`category-marketplace-name ${marketplace}`}><span>{marketplaceLabels[marketplace]}</span></div>
          <div className="category-marketplace-mapping"><span>{marketplaceCategories[marketplace].description || "Não configurada"}</span><span className="muted">{marketplaceCategories[marketplace].code || "Sem código"}</span></div>
          {marketplaceLinks[marketplace]
            ? <span className="muted">Categoria obtida do anúncio</span>
            : <button type="button" className="secondary compact" onClick={() => loadCategories(marketplace)}>Alterar categoria</button>}
        </div>)}
      </div>
      <input type="hidden" name="mercadoLivreCategoryId" value={marketplaceCategories.mercado_livre.code}/>
      <input type="hidden" name="mercadoLivreCategoryName" value={marketplaceCategories.mercado_livre.description}/>
      <input type="hidden" name="shopeeCategoryId" value={marketplaceCategories.shopee.code}/>
      <input type="hidden" name="shopeeCategoryName" value={marketplaceCategories.shopee.description}/>
      <div className="marketplace-attribute-columns">
        <ProductMarketplaceAttributes marketplace="mercado_livre" definitions={mapping?.attribute_definitions?.mercado_livre?.attributes || {}} values={storedAttributes.mercado_livre?.attributes || {}} product={product} activeAttributes={(product as any).marketplace_active_attributes}/>
        <ProductMarketplaceAttributes marketplace="shopee" definitions={mapping?.attribute_definitions?.shopee?.attributes || {}} values={storedAttributes.shopee?.attributes || {}} product={product} activeAttributes={(product as any).marketplace_active_attributes}/>
      </div>
    </section>
    {picker && <div className="modal-backdrop"><section className="card category-modal"><div className="topbar"><div><h2>Categoria — {marketplaceLabels[picker]}</h2><div className="muted">{trail.map(item => item.name).join(" > ") || "Raiz"}</div></div><button className="secondary" type="button" onClick={() => setPicker(null)}>Fechar</button></div><input placeholder="Pesquisar por código ou descrição" value={categoryQuery} onChange={event => setCategoryQuery(event.target.value)}/>{categoryError && <div className="form-error">{categoryError}</div>}{categoryLoading ? <p>Carregando categorias atuais...</p> : <div className="category-tree">{trail.length > 0 && <button className="secondary compact" type="button" onClick={() => { const parent = trail.slice(0, -1); loadCategories(picker, parent.at(-1)?.id, parent); }}>Voltar</button>}{visibleNodes.map(node => <div className="category-node" key={node.id}><span><strong>{node.name}</strong><small>{node.id}</small></span><div>{node.hasChildren && <button type="button" className="secondary compact" onClick={() => loadCategories(picker, node.id, [...trail, { id: node.id, name: node.name }])}>Abrir</button>}<button type="button" className="primary compact" onClick={() => chooseMarketplaceCategory(node)}>Selecionar</button></div></div>)}{!visibleNodes.length && <p className="muted">Nenhuma categoria encontrada neste nível.</p>}</div>}</section></div>}

    <section className={`section card${validationAttempted && !validation.cover ? " required-field-error" : ""}`}><div className="editor-images-heading"><div><h2>Imagens</h2><span>A primeira imagem sempre será enviada como Foto 01.</span>{validationAttempted && !validation.cover && <small className="required-field-message">Preencha o campo obrigatório: adicione pelo menos a Foto 1.</small>}</div><button className="secondary" type="button" onClick={() => inputRef.current?.click()}>Adicionar imagens</button></div>
    <input ref={inputRef} className="visually-hidden" type="file" name="newImages" accept="image/jpeg,image/png,image/webp" multiple onChange={(event) => {
      for (const image of newImagePreviews) URL.revokeObjectURL(image.url);
      const selected = Array.from(event.currentTarget.files || []).map(file => ({ name: file.name, url: URL.createObjectURL(file) }));
      setNewImagePreviews(selected);
      if (selected.length) setDirty(true);
    }} />
    {newImagePreviews.length > 0 && <div className="form-success">{newImagePreviews.length} nova(s) foto(s) selecionada(s). Clique em Atualizar para concluir a inclusão.</div>}
    <div className="editable-image-grid">
      {ordered.map((image, index) => <figure className="editable-product-image" key={image.id}>
        <button type="button" className="image-preview-button" onClick={() => setPreview(image.url)}><img src={image.url} alt={image.name} /></button>
        {index === 0 && <strong className="cover-badge">Foto da Capa</strong>}
        <button type="button" className="image-trash" aria-label={`Excluir ${image.name}`} onClick={() => remove(image.id)}>🗑</button>
        <figcaption><button type="button" disabled={index === 0} onClick={() => move(index, -1)}>←</button><span>{String(index + 1).padStart(2, "0")}</span><button type="button" disabled={index === ordered.length - 1} onClick={() => move(index, 1)}>→</button></figcaption>
      </figure>)}
      {newImagePreviews.map((image, index) => <figure className="editable-product-image" key={image.url}>
        <button type="button" className="image-preview-button" onClick={() => setPreview(image.url)}><img src={image.url} alt={image.name} /></button>
        <strong className="cover-badge">Aguardando salvar</strong>
        <figcaption><span>{String(ordered.length + index + 1).padStart(2, "0")}</span></figcaption>
      </figure>)}
    </div></section>
    {preview && <button type="button" className="image-preview-modal" onClick={() => setPreview("")}><img src={preview} alt="Visualização ampliada" /></button>}
    <div className="product-detail-footer-actions row-actions">
      <a className="secondary" href={`/historico-estoque?produto=${product.id}`}>Histórico de Estoque</a>
      <button className="primary" type="submit" disabled={!dirty}>Atualizar</button>
      <a className="secondary" href={returnTo}>Voltar</a>
    </div>
  </form>
  {pendingHref && <div className="modal-backdrop"><div className="confirm-modal"><h3>Atualizações não salvas no produto.</h3><p>Deseja salvar antes de sair?</p><div className="modal-actions"><button type="button" className="secondary" onClick={() => { const href = pendingHref; setDirty(false); setPendingHref(""); window.location.href = href; }}>Não</button><button type="button" className="primary" onClick={() => { setDirty(false); formRef.current?.requestSubmit(); }}>Sim</button></div></div></div>}
  </>;
}

function QuantityControl({ label, name, value, setValue, onDirty }: { label:string; name:string; value:number; setValue:(value:number)=>void; onDirty:()=>void }) {
  const update = (next:number) => { setValue(Math.max(0, next)); onDirty(); };
  const change = (delta:number) => update(value + delta);
  return <label>{label}<span className="quantity-control"><button type="button" className="secondary compact" onClick={() => change(-1)} aria-label={`Diminuir ${label}`}>−</button><input name={name} type="number" min="0" step="1" required value={value} onChange={event => update(Math.trunc(Number(event.target.value) || 0))}/><button type="button" className="secondary compact" onClick={() => change(1)} aria-label={`Aumentar ${label}`}>+</button></span></label>;
}

function ProductMarketplaceAttributes({ marketplace, definitions, values, product, activeAttributes }: { marketplace:string;definitions:Record<string,any>;values:Record<string,any>;product:Record<string,any>;activeAttributes?:Record<string,string[]>|null }) {
  const configured = activeAttributes?.[marketplace];
  const visible = activeAttributes == null || configured === undefined ? Object.values(definitions) : Object.values(definitions).filter((attribute:any) => configured.includes(String(attribute.id)));
  return <div className="marketplace-attribute-panel"><h3>{marketplace === "shopee" ? "Shopee" : "Mercado Livre"}</h3>{visible.map((attribute:any) => {
    const base=`productAttribute.${marketplace}.${attribute.id}`; const value=values[attribute.id]||{}; const automatic=automaticProductValue(attribute.systemSource,product);
    if (attribute.systemSource && !["100121","100370"].includes(String(attribute.id))) return <label key={attribute.id}>{attribute.name}<input readOnly value={automatic || value.valueName || ""}/><small>Preenchimento automático pelo Produto</small></label>;
    if (["select","combo","boolean"].includes(attribute.inputType) && attribute.options?.length) return <label key={attribute.id}>{attribute.name}{attribute.required?" *":""}<select required={Boolean(attribute.required)} name={`${base}.valueId`} defaultValue={String(value.valueId||"")}><option value="">Selecione</option>{attribute.options.map((option:any)=><option key={option.id} value={option.id}>{option.name}</option>)}</select></label>;
    return <label key={attribute.id}>{attribute.name}{attribute.required?" *":""}<input required={Boolean(attribute.required)} name={`${base}.valueName`} type={attribute.inputType === "number" ? "number":"text"} defaultValue={String(value.valueName||"")}/><small>{attribute.id}</small></label>;
  })}{!visible.length && <p className="muted">Nenhum atributo ativo para este Tipo.</p>}</div>;
}
function automaticProductValue(source:string|undefined,product:Record<string,any>){ const map:Record<string,unknown>={brand:product.brand_name,model:product.model,board_code:product.board_code,sku:product.sku,title:product.title,description:product.description,product_condition:product.product_condition,height:product.height,width:product.width,length:product.length,weight_gross:product.weight_gross}; return source ? String(map[source]??"") : ""; }
