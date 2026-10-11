import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),Module=require('node:module');
const React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
const original=Module._load;let modal:any=null,index=0;
Module._load=function(name:string,...args:any[]){
 if(name==='react')return {...React,useEffect:()=>{},useRef:()=>({current:true}),useState:(initial:any)=>{const position=index++;return [position===0?modal:initial,()=>{}]}};
 if(name==='next/navigation')return {useRouter:()=>({refresh(){}})};
 if(name.endsWith('.module.css'))return {};
 return original.call(this,name,...args);
};
const {ClaimControls}=require('../app/central-reclamacoes/claim-controls');Module._load=original;
for(const cost of [null,{amount:0,currency_id:'BRL'},{amount:10.99,currency_id:'BRL'}])test(`actual modal renders cost ${cost?.amount}`,()=>{
 index=0;modal={action:'allow_return',returnCost:cost,context:{buyerName:'Comprador',orderId:'456',claimId:'123',products:[{title:'Produto',quantity:1}],orderAmount:100,paidAmount:110,currency:'BRL'}};
 const html=renderToStaticMarkup(React.createElement(ClaimControls,{id:'case',data:{row:{status:'opened'},actions:[{action_code:'allow_return'}]},mode:'actions',onChange(){}}));
 assert.match(html,/Comprador/);assert.match(html,/Produto/);assert.match(html,cost===null?/Não disponível para consulta/:cost.amount===0?/Gratuito para você/:/10,99/);assert.doesNotMatch(html,/7 dias/);
});
