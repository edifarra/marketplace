import {loadEnvConfig} from '@next/env';
import {supabaseAdmin} from '../lib/supabase-admin';
import {extractMercadoLivreSaleIdentifiers} from '../lib/mercado-livre-sale-identifiers';

// Deliberately bypass token-refresh helpers: this validation never writes or replays events.
const cases=[
 {order:'2000019185840280',shipping:'48356063630',payment:'185223598025'},
 {order:'2000019390390724',pack:'2000015910289801',shipping:'48452254311',payment:'187208629737'},
 {order:'2000019269687890',pack:'2000015798640445',shipping:'48396410546',payment:'186066030871'}
];
async function run(){
 loadEnvConfig(process.cwd());
 const db=supabaseAdmin();
 const {data:accounts}=await db.from('config_marketplace_accounts')
  .select('id,seller_id,account_id,access_token').eq('marketplace','mercado_livre').throwOnError();
 let failed=false;
 for(const target of cases){
  const {data:sales}=await db.from('venda').select('id,order_id,raw_data,valor_liquido,data_pagamento,data_liberacao')
   .eq('marketplace','mercado_livre').eq('order_id',target.order).throwOnError();
  if(sales?.length!==1)throw new Error(`Venda não identificada de forma única: ${target.order}`);
  const before=sales[0];
  const account=accounts?.find(a=>a.id===before.raw_data?.marketplace_account_id);
  if(!account?.access_token)throw new Error(`Credencial de leitura indisponível: ${target.order}`);
  const get=async(url:string)=>{
   const response=await fetch(url,{method:'GET',headers:{Authorization:`Bearer ${account.access_token}`},redirect:'error',signal:AbortSignal.timeout(15000)});
   if(!response.ok)throw new Error(`API GET recusou consulta (${response.status}) do pedido ${target.order}`);
   return response.json();
  };
  const order=await get(`https://api.mercadolibre.com/orders/${target.order}`);
  const payment=await get(`https://api.mercadopago.com/v1/payments/${target.payment}`);
  const identifiers=extractMercadoLivreSaleIdentifiers(order);
  const has=(type:string,value:string)=>identifiers.some(i=>i.identifierType===type&&i.identifierValue===value);
  const owner=String(account.seller_id||account.account_id);
  const passed=String(order.id)===target.order&&String(order.seller?.id)===owner
   &&has('ORDER_ID',target.order)&&has('SHIPPING_ID',target.shipping)&&has('PAYMENT_ID',target.payment)
   &&(!target.pack||has('PACK_ID',target.pack))&&String(payment.id)===target.payment
   &&String(payment.collector_id)===owner&&String(payment.order?.id)===target.order;
  const {data:after}=await db.from('venda').select('valor_liquido,data_pagamento,data_liberacao')
   .eq('id',before.id).single().throwOnError();
  const unchanged=['valor_liquido','data_pagamento','data_liberacao'].every(k=>(before as any)[k]===(after as any)[k]);
  console.log(JSON.stringify({order:target.order,mode:'READ_ONLY',passed,commercialFinancialSnapshotUnchanged:unchanged,identifiers}));
  if(!passed||!unchanged)failed=true;
 }
 if(failed)process.exitCode=1;
}
run().catch(error=>{console.error(error instanceof Error?error.message:'Falha na homologação somente leitura');process.exitCode=1;});
