import { createClient } from "@supabase/supabase-js";
const db=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY||process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const batches=(a,n)=>Array.from({length:Math.ceil(a.length/n)},(_,i)=>a.slice(i*n,(i+1)*n));
const {data:tokenRow,error:tokenError}=await db.from("settings").select("value").eq("key","TINY_TOKEN").single();
if(tokenError||!tokenRow?.value)throw new Error("TINY_TOKEN nao localizado");
const token=typeof tokenRow.value==="string"?tokenRow.value:String(tokenRow.value);
async function api(endpoint,params,attempt=1){
  const response=await fetch(`https://api.tiny.com.br/api2/${endpoint}`,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({token,formato:"json",...params})});
  const raw=await response.text(); let json; try{json=JSON.parse(raw)}catch{}
  if(response.ok&&json?.retorno?.status==="OK")return json.retorno;
  if(attempt<4){await wait(attempt*1500);return api(endpoint,params,attempt+1)}
  throw new Error(JSON.stringify(json?.retorno?.erros||raw));
}
async function progress(value){await db.from("settings").upsert({key:"TINY_IMPORT_PROGRESS",value:{...value,updatedAt:new Date().toISOString()},description:"[TINY] Progresso da importacao"})}
await progress({status:"catalog",processed:0,total:0});
await db.from("config_types").upsert({code:"OT",description:"Outros",sku_group:"OUTROS",sku_max:0,title_template:"[NOME_PRODUTO_COMPLETO]",description_template:"[NOME_PRODUTO_COMPLETO]"},{onConflict:"code"});
await db.from("config_brands").upsert({code:"NI",name:"Nao informada",include_in_title:false},{onConflict:"code"});
const first=await api("produtos.pesquisa.php",{pesquisa:"",pagina:"1"}); let catalog=(first.produtos||[]).map(x=>x.produto); const pages=Number(first.numero_paginas||1);
for(let page=2;page<=pages;page++){const result=await api("produtos.pesquisa.php",{pesquisa:"",pagina:String(page)});catalog.push(...(result.produtos||[]).map(x=>x.produto));await progress({status:"catalog",processed:catalog.length,total:pages*100,page,pages})}
const [{data:types},{data:brands},{data:existing}]=await Promise.all([db.from("config_types").select("code"),db.from("config_brands").select("code"),db.from("products").select("id,sku,source_key,tiny_product_id")]);
const typeCodes=new Set((types||[]).map(x=>x.code)),brandCodes=new Set((brands||[]).map(x=>x.code));
const byTiny=new Map((existing||[]).filter(x=>x.tiny_product_id).map(x=>[String(x.tiny_product_id),x])),bySource=new Map((existing||[]).map(x=>[x.source_key,x])),bySku=new Map((existing||[]).map(x=>[x.sku.toLowerCase(),x]));
const used=new Set((existing||[]).map(x=>x.sku.toLowerCase()));
const aliases=[["SAMSUNG","SA"],["PHILCO","PT"],["PHILIPS","PU"],["SONY","SO"],["AOC","AO"],["HISENSE","HI"],["MULTILASER","MU"],["TOSHIBA","TS"],["SEMP TCL","TC"],["TCL","TC"],["LG","LG"]];
function typeOf(p){const t=`${p.codigo||""} ${p.nome||""}`.toUpperCase(),known=[["PLACA PRINCIPAL","PP"],["PLACA DE FONTE","PF"],["PLACA FONTE","PF"],["T-CON","TC"],["T CON","TC"],["ALTO FALANTE","AU"],["PEDESTAL","PE"],["PLACA INVERTER","PV"],["CONTROLADORA LED","CL"]].find(([n,c])=>t.includes(n)&&typeCodes.has(c));return known?.[1]||"OT"}
function brandOf(p){const t=String(p.nome||"").toUpperCase();return aliases.find(([n,c])=>t.includes(n)&&brandCodes.has(c))?.[1]||"NI"}
function skuOf(p){const base=String(p.codigo||"").trim()||`TINY-${p.id}`;if(!used.has(base.toLowerCase())){used.add(base.toLowerCase());return base}const alt=`${base}-TINY-${p.id}`;used.add(alt.toLowerCase());return alt}
const inserts=[],updates=[];
for(const p of catalog){const source=`TINY_${p.id}`,linked=byTiny.get(String(p.id))||bySource.get(source)||(p.codigo?bySku.get(String(p.codigo).trim().toLowerCase()):null),sku=linked?.sku||skuOf(p),title=String(p.nome||`Produto Tiny ${p.id}`).trim();const payload={sku,source_key:source,type_code:typeOf(p),brand_code:brandOf(p),title,description:title,price:Number(p.preco||p.preco_promocional||0),stock:0,status:p.situacao==="I"?"draft":"sent",tiny_product_id:String(p.id),sent_target:"TINY",sent_at:new Date().toISOString(),updated_at:new Date().toISOString()};linked?updates.push({id:linked.id,payload}):inserts.push(payload)}
for(const batch of batches(inserts,100)){const {error}=await db.from("products").insert(batch);if(error)throw error}
for(const x of updates){const {error}=await db.from("products").update(x.payload).eq("id",x.id);if(error)throw error}
await progress({status:"stock",processed:0,total:catalog.length,inserted:inserts.length,updated:updates.length,failed:0});
const {data:locals}=await db.from("products").select("id,sku,tiny_product_id").not("tiny_product_id","is",null);const localByTiny=new Map((locals||[]).map(x=>[String(x.tiny_product_id),x]));let processed=0,failed=0;
for(const group of batches(catalog,3)){const rows=[];await Promise.all(group.map(async p=>{try{const result=await api("produto.obter.estoque.php",{id:String(p.id)});const stock=Math.max(0,Math.trunc((result.produto?.depositos||[]).reduce((sum,x)=>sum+Number(x.deposito?.saldo||0),0))),local=localByTiny.get(String(p.id));if(local)rows.push({product_id:local.id,sku:local.sku,estoque_fisico:stock})}catch{failed++}processed++}));if(rows.length){const {error}=await db.from("estoque").upsert(rows,{onConflict:"product_id"});if(error)throw error}if(processed%30<3||processed===catalog.length)await progress({status:"stock",processed,total:catalog.length,inserted:inserts.length,updated:updates.length,failed});await wait(1000)}
await progress({status:failed?"done_with_errors":"done",processed,total:catalog.length,inserted:inserts.length,updated:updates.length,failed,finishedAt:new Date().toISOString()});
console.log(JSON.stringify({total:catalog.length,inserted:inserts.length,updated:updates.length,stockProcessed:processed,failed}));
