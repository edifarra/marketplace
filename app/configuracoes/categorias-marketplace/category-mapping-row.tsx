"use client";
import { useMemo, useState } from "react";
import Image from "next/image";
import { deleteCategoryMapping, renameCategoryMapping, saveCategoryMapping, updateCategoryAttributes } from "./actions";
import type { MarketplaceDefinitions } from "@/lib/marketplace-attributes";

type Marketplace = "mercado_livre" | "shopee" | "tiny";
type Node = { id: string; name: string; hasChildren: boolean };
type Mapping = Record<string, unknown>;
const labels = { mercado_livre: "Mercado Livre", shopee: "Shopee", tiny: "Tiny" };

export function CategoryMappingRow({ category, mapping }: { category: string; mapping?: Mapping }) {
  const [selected, setSelected] = useState<Record<Marketplace,{code:string;description:string}>>({
    mercado_livre:{code:String(mapping?.mercado_livre_code||""),description:String(mapping?.mercado_livre_description||"")},
    shopee:{code:String(mapping?.shopee_code||""),description:String(mapping?.shopee_description||"")},
    tiny:{code:String(mapping?.tiny_code||""),description:String(mapping?.tiny_description||"")}
  });
  const [picker,setPicker]=useState<Marketplace|null>(null); const [nodes,setNodes]=useState<Node[]>([]); const [trail,setTrail]=useState<Array<{id:string;name:string}>>([]); const [query,setQuery]=useState(""); const [error,setError]=useState(""); const [loading,setLoading]=useState(false);
  const [categoryAction, setCategoryAction] = useState<"rename" | "delete" | null>(null);
  const visible=useMemo(()=>nodes.filter(node=>`${node.id} ${node.name}`.toLowerCase().includes(query.toLowerCase())),[nodes,query]);
  async function load(marketplace:Marketplace,parent?:string, nextTrail:Array<{id:string;name:string}>=[]) { setLoading(true);setError("");setPicker(marketplace);setQuery(""); try { const url=`/api/marketplace-categories/${marketplace}${parent?`?parent=${encodeURIComponent(parent)}`:""}`; const response=await fetch(url); const json=await response.json(); if(!response.ok) throw new Error(json.error||"Falha ao buscar categorias."); setNodes(json.nodes||[]);setTrail(nextTrail); } catch(e){setError(e instanceof Error?e.message:String(e));setNodes([]);} finally{setLoading(false);} }
  function choose(node:Node){ if(!picker)return; const path=[...trail,{id:node.id,name:node.name}].map(item=>item.name).join(" > "); setSelected({...selected,[picker]:{code:node.id,description:path}});setPicker(null); }
  const marketplaces = ["mercado_livre","shopee","tiny"] as Marketplace[];
  const definitions = (mapping?.attribute_definitions || {}) as unknown as MarketplaceDefinitions;
  return <section className="card category-mapping-card">
    <div className="category-internal-heading"><div><span>Categoria Interna</span><h2>{category}</h2></div>{mapping && <div className="category-internal-actions"><button className="secondary compact" type="button" onClick={() => setCategoryAction("rename")}>Alterar descrição</button><button className="danger compact" type="button" onClick={() => setCategoryAction("delete")}>Excluir mapeamento</button></div>}</div>
    <div className="category-marketplace-list">
      {marketplaces.map(m=><div className="category-marketplace-row" key={m}>
        <div className={`category-marketplace-name ${m}`}><MarketplaceSymbol marketplace={m}/><span>{labels[m]}</span></div>
        <div className="category-marketplace-mapping"><span>{selected[m].description||"Não mapeada"}</span><span className="muted">{selected[m].code||"Sem código"}</span></div>
        <button type="button" className="secondary compact" onClick={()=>load(m)}>Mapear</button>
      </div>)}
    </div>
    <form className="category-mapping-actions" action={saveCategoryMapping}>
      <input type="hidden" name="internal_category" value={category}/>
      {marketplaces.flatMap(m=>[<input key={`${m}-code`} type="hidden" name={`${m}_code`} value={selected[m].code}/>,<input key={`${m}-description`} type="hidden" name={`${m}_description`} value={selected[m].description}/>])}
      <button className="primary" type="submit">Salvar mapeamentos</button>
    </form>
    <div className="category-attribute-actions">
      <form action={updateCategoryAttributes}><input type="hidden" name="internal_category" value={category}/><button className="secondary" type="submit">Atualizar atributos</button></form>
    </div>
    {(["mercado_livre", "shopee"] as const).map(marketplace => definitions[marketplace] ? <details className="category-attributes" key={marketplace}>
      <summary>{labels[marketplace]} — {Object.keys(definitions[marketplace]?.attributes || {}).length} campos</summary>
      <div className="table-wrap"><table><thead><tr><th>Campo</th><th>Entrada</th><th>Regra</th><th>Opções</th></tr></thead><tbody>
        {Object.values(definitions[marketplace]?.attributes || {}).map(attribute => <tr key={attribute.id}><td><strong>{attribute.name}</strong><small>{attribute.id}</small></td><td>{inputTypeLabel(attribute.inputType)}</td><td>{attribute.required ? "Obrigatório" : attribute.conditionalRequired ? "Condicional" : "Opcional"}</td><td>{attribute.options.length ? `${attribute.options.length} opções` : "Livre"}</td></tr>)}
      </tbody></table></div>
    </details> : null)}
    {categoryAction === "rename" && <div className="modal-backdrop" role="presentation"><section className="card category-action-modal"><h2>Alterar descrição da Categoria Interna</h2><p className="muted">Esta alteração modifica somente este mapeamento.</p><form action={renameCategoryMapping}><input type="hidden" name="current_internal_category" value={category}/><label>Nova descrição<input name="internal_category" defaultValue={category} required autoFocus/></label><div className="modal-actions"><button className="secondary" type="button" onClick={() => setCategoryAction(null)}>Cancelar</button><button className="primary" type="submit">Salvar alteração</button></div></form></section></div>}
    {categoryAction === "delete" && <div className="modal-backdrop" role="presentation"><section className="card category-action-modal"><h2>Excluir mapeamento?</h2><p>O mapeamento de <strong>{category}</strong> será excluído. A categoria e os demais cadastros não serão apagados.</p><form action={deleteCategoryMapping}><input type="hidden" name="internal_category" value={category}/><div className="modal-actions"><button className="secondary" type="button" onClick={() => setCategoryAction(null)}>Cancelar</button><button className="danger" type="submit">Excluir mapeamento</button></div></form></section></div>}
    {picker&&<div className="modal-backdrop"><section className="card category-modal"><div className="topbar"><div><h2>Mapear {labels[picker]}</h2><div className="muted">{trail.map(t=>t.name).join(" > ")||"Raiz"}</div></div><button className="secondary" type="button" onClick={()=>setPicker(null)}>Fechar</button></div><input placeholder="Pesquisar por código ou descrição" value={query} onChange={e=>setQuery(e.target.value)}/>{error&&<div className="form-error">{error}</div>}{loading?<p>Carregando categorias atuais...</p>:<div className="category-tree">{trail.length>0&&<button className="secondary compact" type="button" onClick={()=>{const parent=trail.slice(0,-1);load(picker,parent.at(-1)?.id,parent)}}>Voltar</button>}{visible.map(node=><div className="category-node" key={node.id}><span><strong>{node.name}</strong><small>{node.id}</small></span><div>{node.hasChildren&&<button type="button" className="secondary compact" onClick={()=>load(picker,node.id,[...trail,{id:node.id,name:node.name}])}>Abrir</button>}<button type="button" className="primary compact" onClick={()=>choose(node)}>Selecionar</button></div></div>)}{!visible.length&&<p className="muted">Nenhuma categoria encontrada neste nível.</p>}</div>}</section></div>}
  </section>;
}

function inputTypeLabel(value: string) {
  return ({ text: "Texto", number: "Número", select: "Seleção", combo: "Combinação", multi_select: "Seleção múltipla", multi_combo: "Combinação múltipla", boolean: "Sim/Não", date: "Data" } as Record<string,string>)[value] || value;
}

function MarketplaceSymbol({ marketplace }: { marketplace: Marketplace }) {
  if (marketplace === "tiny") return <span className="category-marketplace-symbol tiny" aria-hidden="true">T</span>;
  const src = marketplace === "mercado_livre" ? "/marketplaces/mercado-livre.svg" : "/marketplaces/shopee.svg";
  return <span className="category-marketplace-symbol" aria-hidden="true"><Image src={src} alt="" width={18} height={18}/></span>;
}
