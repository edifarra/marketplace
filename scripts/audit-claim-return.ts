// Read-only audit: stored token only; no refresh, RPC or marketplace action.
import {supabaseAdmin} from '../lib/supabase-admin';
import {loadMercadoLivreClaimBundle} from '../lib/marketplace-case-enrichment';
const originalFetch=globalThis.fetch;
globalThis.fetch=async(input,init)=>{const method=init?.method || (input instanceof Request ? input.method : "GET");if(!["GET","HEAD"].includes(method))throw new Error("Audit blocked mutation");return originalFetch(input,init);};
const db=supabaseAdmin();
async function main(){
for(const claim of ['5591866489','5592119231']){
const row=(await db.from('marketplace_cases').select('marketplace_account_id').eq('external_case_id',claim).single().throwOnError()).data;
const account=(await db.from('config_marketplace_accounts').select('seller_id,account_id,access_token').eq('id',row.marketplace_account_id).single().throwOnError()).data;
const read=async(path:string)=>{const r=await fetch('https://api.mercadolibre.com'+path,{headers:{authorization:'Bearer '+account.access_token},signal:AbortSignal.timeout(20000)});console.log(JSON.stringify({claim,path,status:r.status}));if(!r.ok)throw new Error('HTTP '+r.status);return r.json();};
try{const b=await loadMercadoLivreClaimBundle(claim,account as any,read);console.log(JSON.stringify({claim,revision:b.last_updated,products:b.__case_enrichment.buyer.products}));}catch{console.log('bundle unavailable');}
try{console.log(JSON.stringify({claim,cost:await read('/post-purchase/v1/claims/'+claim+'/charges/return-cost')}));}catch{console.log('cost unavailable');}
}}
main().catch(()=>{console.error('Read-only audit failed; no remote writes executed.');process.exitCode=1});
