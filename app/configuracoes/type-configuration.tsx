"use client";
import { useMemo, useState } from "react";
import Image from "next/image";
import { saveTypeConfiguration } from "./tipo-actions";
import type { AttributeDefinition, MarketplaceDefinitions, MarketplaceValues } from "@/lib/marketplace-attributes";

type Mapping = { internal_category: string; mercado_livre_code?: string; mercado_livre_description?: string; shopee_code?: string; shopee_description?: string; attribute_definitions?: MarketplaceDefinitions };
type TypeRow = Record<string, any>;
type ActiveAttributes = Partial<Record<"mercado_livre" | "shopee", string[]>> | null;

export function TypeConfiguration({ rows, mappings, editRow, showForm }: { rows: TypeRow[]; mappings: Mapping[]; editRow?: TypeRow; showForm: boolean }) {
  const [category, setCategory] = useState(String(editRow?.marketplace_category || mappings[0]?.internal_category || ""));
  const [activeAttributes, setActiveAttributes] = useState<ActiveAttributes>(editRow?.marketplace_active_attributes ?? null);
  const selected = useMemo(() => mappings.find(item => item.internal_category === category), [mappings, category]);
  const defaults = (editRow?.marketplace_attribute_defaults || {}) as MarketplaceValues;
  if (!showForm) return <TypeGrid rows={rows}/>;
  return <>
    <TypeGrid rows={rows}/>
    <section className="section card type-editor"><h2>{editRow ? `Editar Tipo ${editRow.code}` : "Novo Tipo"}</h2>
      <form action={saveTypeConfiguration} className="config-form">
        {editRow && <input type="hidden" name="originalCode" value={String(editRow.code)}/>} 
        <TypeBlock title="Configurações do Tipo"><div className="form-grid">
          <Field name="code" label="Sigla" value={editRow?.code} required/><Field name="description" label="Descrição" value={editRow?.description} required/>
          <Field name="sku_group" label="Grupo SKU" value={editRow?.sku_group} required/><Field name="sku_max" label="SKU Max" value={editRow?.sku_max} type="number"/>
          <Field name="warranty_months" label="Garantia (meses)" value={editRow?.warranty_months} type="number"/>
        </div></TypeBlock>
        <TypeBlock title="Configurações de Categoria">
          <label>Categoria Interna<select name="marketplace_category" value={category} onChange={event => { setCategory(event.target.value); setActiveAttributes(null); }} required><option value="">Selecione</option>{mappings.map(item => <option key={item.internal_category} value={item.internal_category}>{item.internal_category}</option>)}</select></label>
          {selected ? <div className="marketplace-attribute-columns">
            <MarketplaceFields marketplace="mercado_livre" code={selected.mercado_livre_code} description={selected.mercado_livre_description} definitions={selected.attribute_definitions?.mercado_livre?.attributes || {}} values={defaults.mercado_livre?.attributes || {}} activeAttributes={activeAttributes} setActiveAttributes={setActiveAttributes}/>
            <MarketplaceFields marketplace="shopee" code={selected.shopee_code} description={selected.shopee_description} definitions={selected.attribute_definitions?.shopee?.attributes || {}} values={defaults.shopee?.attributes || {}} activeAttributes={activeAttributes} setActiveAttributes={setActiveAttributes}/>
          </div> : null}
        </TypeBlock>
        <TypeBlock title="Configurações Gerais"><div className="form-grid">
          <Field name="search_term" label="Campo de Busca" value={editRow?.search_term}/><Field name="weight_net" label="Peso líquido (kg)" value={editRow?.weight_net} type="number"/>
          <Field name="weight_gross" label="Peso bruto (kg)" value={editRow?.weight_gross} type="number"/><Field name="width" label="Largura (cm)" value={editRow?.width} type="number"/>
          <Field name="height" label="Altura (cm)" value={editRow?.height} type="number"/><Field name="length" label="Comprimento (cm)" value={editRow?.length} type="number"/>
        </div></TypeBlock>
        <TemplateBlock title="Título do Anúncio" name="title_template" value={String(editRow?.title_template || "[TIPO] [MARCA] [MODELO] [VERSAO] [CODIGO] [ESPECIAL]")}/>
        <TemplateBlock title="Descrição do Anúncio" name="description_template" value={String(editRow?.description_template || "Produto: [NOME_PRODUTO_COMPLETO]")}/>
        <div className="form-actions"><a className="secondary" href="/configuracoes/tipo">Cancelar</a><button className="primary" type="submit">Salvar</button></div>
      </form>
    </section>
  </>;
}

function TypeGrid({ rows }: { rows: TypeRow[] }) { return <section className="card"><div className="table-toolbar"><div><h2>Tipos</h2><div className="muted">{rows.length} configurações</div></div><a className="primary" href="/configuracoes/tipo?novo=1">Novo</a></div><div className="table-wrap"><table><thead><tr><th>Sigla</th><th>Descrição</th><th>Grupo SKU</th><th>Categoria Interna</th><th>Garantia</th></tr></thead><tbody>{rows.map(row => <tr className="clickable-row" key={row.code} onClick={() => location.href = `/configuracoes/tipo?edit=${encodeURIComponent(row.code)}`}><td><strong>{row.code}</strong></td><td>{row.description}</td><td>{row.sku_group}</td><td>{row.marketplace_category || "—"}</td><td>{Number(row.warranty_months || 0)} meses</td></tr>)}</tbody></table></div></section>; }
function TypeBlock({ title, children }: { title: string; children: React.ReactNode }) { return <fieldset className="type-config-block"><legend>{title}</legend>{children}</fieldset>; }
function Field({ name, label, value, type="text", required=false }: { name:string;label:string;value?:unknown;type?:string;required?:boolean }) { return <label>{label}<input name={name} type={type} step={type === "number" ? "0.001" : undefined} required={required} defaultValue={String(value ?? "")}/></label>; }

function MarketplaceFields({ marketplace, code, description, definitions, values, activeAttributes, setActiveAttributes }: { marketplace:"mercado_livre"|"shopee";code?:string;description?:string;definitions:Record<string,AttributeDefinition>;values:Record<string,any>;activeAttributes:ActiveAttributes;setActiveAttributes:React.Dispatch<React.SetStateAction<ActiveAttributes>> }) {
  const visible = Object.values(definitions);
  const toggle = (attributeId: string, active: boolean) => setActiveAttributes(current => {
    const allIds = visible.map(item => item.id);
    const next = new Set(current === null ? allIds : current?.[marketplace] || []);
    active ? next.add(attributeId) : next.delete(attributeId);
    return { ...(current || {}), [marketplace]: [...next] };
  });
  return <section className="marketplace-attribute-panel"><div className="marketplace-attribute-heading"><Image src={marketplace === "shopee" ? "/marketplaces/shopee.svg" : "/marketplaces/mercado-livre.svg"} width={26} height={26} alt=""/><div><strong>{marketplace === "shopee" ? "Shopee" : "Mercado Livre"}</strong><span>{description || "Não mapeada"}</span><code>{code || "—"}</code></div></div><input type="hidden" name={`${marketplace}_category_id`} value={code || ""}/>
    {!visible.length ? <p className="muted">Nenhum atributo adicional sincronizado.</p> : visible.map(attribute => { const configured = activeAttributes?.[marketplace]; const active = activeAttributes === null || configured === undefined || configured.includes(attribute.id); return <AttributeInput key={attribute.id} marketplace={marketplace} attribute={attribute} value={values[attribute.id] || {}} active={active} onActiveChange={checked => toggle(attribute.id, checked)}/>; })}
  </section>;
}
function AttributeInput({ marketplace, attribute, value, active, onActiveChange }: { marketplace:string;attribute:AttributeDefinition;value:any;active:boolean;onActiveChange:(active:boolean)=>void }) {
  const base = `attribute.${marketplace}.${attribute.id}`; const label = `${attribute.name}${attribute.required ? " *" : ""}`;
  const status = <span className="type-attribute-status"><input type="checkbox" name={`activeAttribute.${marketplace}.${attribute.id}`} value="1" checked={active} onChange={event => onActiveChange(event.target.checked)}/><span>{active ? "Ativo" : "Inativo"}</span></span>;
  if (attribute.systemSource && !["100121", "100370"].includes(attribute.id)) return <label className={`type-attribute-field${active ? " active" : " inactive"}`}><span className="type-attribute-label"><span>{label}</span>{status}</span><input value="Preenchimento automático pelo Produto" readOnly disabled/><small>{attribute.originalName} · {attribute.id}</small></label>;
  if (["select","combo","boolean"].includes(attribute.inputType) && attribute.options.length) return <label className={`type-attribute-field${active ? " active" : " inactive"}`}><span className="type-attribute-label"><span>{label}</span>{status}</span><select name={`${base}.valueId`} defaultValue={String(value.valueId || "")} disabled={!active}><option value="">Selecione</option>{attribute.options.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}</select><input type="hidden" name={`${base}.valueName`} value={String(attribute.options.find(option => option.id === String(value.valueId))?.originalName || value.valueName || "")} disabled={!active}/></label>;
  return <label className={`type-attribute-field${active ? " active" : " inactive"}`}><span className="type-attribute-label"><span>{label}</span>{status}</span><input name={`${base}.valueName`} type={attribute.inputType === "number" ? "number" : "text"} defaultValue={String(value.valueName || "")} disabled={!active}/><small>{attribute.originalName} · {attribute.id}</small></label>;
}
function TemplateBlock({ title, name, value }: { title:string;name:string;value:string }) { const [template,setTemplate]=useState(value); const render=(defect:boolean)=>template.replaceAll("[TIPO]","Placa Fonte TV").replaceAll("[MARCA]","LG").replaceAll("[MODELO]","55UP").replaceAll("[VERSAO]","").replaceAll("[CODIGO]","EAX123").replaceAll("[NOME_PRODUTO_COMPLETO]","Placa Fonte TV LG 55UP EAX123").replaceAll("[ESPECIAL]",defect?"D Defeito":""); return <TypeBlock title={`Configurações Template — ${title}`}><label>Configuração<textarea name={name} value={template} onChange={event=>setTemplate(event.target.value)} rows={4}/></label><div className="template-previews"><div><strong>Preview sem especial D</strong><p>{render(false)}</p></div><div><strong>Preview com especial D (Defeito)</strong><p>{render(true)}</p></div></div></TypeBlock>; }
