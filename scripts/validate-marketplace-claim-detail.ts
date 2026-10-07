// Read-only validation: no token refresh, RPC, queue write or marketplace action.
import assert from 'node:assert/strict';
import { supabaseAdmin } from '../lib/supabase-admin';
import { loadCaseDetail } from '../lib/marketplace-case-detail';
import { loadMercadoLivreClaimBundle } from '../lib/marketplace-case-enrichment';
import { normalizeCase } from '../lib/marketplace-case-domain';
import { caseReason, claimDescription, reputationLabel } from '../app/central-reclamacoes/case-display';
async function main() {
  const originalFetch=globalThis.fetch;
  const dbHost=new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).host;
  globalThis.fetch=async(input,init)=>{
    const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
    assert.ok([dbHost,'api.mercadolibre.com'].includes(url.host));
    assert.ok(['GET','HEAD'].includes(init?.method || (input instanceof Request?input.method:'GET')),'Read-only validation blocked a mutation');
    return originalFetch(input,init);
  };
  try {
    const db=supabaseAdmin();
    const row=(await db.from('marketplace_cases').select('id,marketplace_account_id').eq('marketplace','mercado_livre').eq('case_type','claim').eq('external_case_id','5589264783').single().throwOnError()).data;
    const detail=await loadCaseDetail(row.id,db);assert.ok(detail);
    assert.equal(caseReason(detail.row),'O comprador se arrependeu');
    assert.equal(claimDescription(detail.row),'O comprador disse que chegou em boas condições, mas não quer mais o produto.');
    assert.equal(reputationLabel(detail.row),'Não afeta sua reputação');
    assert.equal(detail.conversation?.external_conversation_id,'claim:5589264783');
    assert.equal(detail.conversation?.marketplace_account_id,row.marketplace_account_id);
    assert.ok(detail.messages.some(m=>m.text.includes('stand bye') && m.sender_name==='Prontolar Freguesia' && m.sent_at));
    assert.equal(detail.row.buyer_data.display_name,'Prontolar Freguesia');
    assert.equal(detail.row.buyer_data.legal_name,'PRONTOLAR DA FREGUESIA COMERCIO E SERVICOS ELETRONICOS LTDA');
    assert.equal(detail.row.buyer_data.document_number,'49979034000169');
    assert.equal(detail.row.buyer_data.fiscal_address.street_name,'Avenida das Américas');
    for(const name of ['Produto entregue','Reclamação aberta','Mensagem','Solução proposta'])assert.ok(detail.timeline.some(e=>e.event_type===name));
    assert.ok(detail.timeline.every((e,i,all)=>i===0 || Date.parse(all[i-1].official_at)<=Date.parse(e.official_at)));
    const account=(await db.from('config_marketplace_accounts').select('seller_id,account_id,access_token').eq('id',row.marketplace_account_id).single().throwOnError()).data;
    const bundle=await loadMercadoLivreClaimBundle('5589264783',account as any,async path=>{
      const response=await fetch('https://api.mercadolibre.com'+path,{headers:{authorization:'Bearer '+account.access_token}});
      assert.equal(response.status,200,`Official read failed: ${path}`);return response.json();
    });
    const observation=normalizeCase({id:'validation-only',marketplace:'mercado_livre',raw_payload:{topic:'post_purchase',claim_id:'5589264783'}},row.marketplace_account_id,bundle)!;
    assert.equal(observation.snapshot.reason_name,detail.row.reason_name);
    assert.equal(observation.snapshot.reputation_impact,detail.row.reputation_impact);
    assert.equal(observation.snapshot.buyer_data.document_number,detail.row.buyer_data.document_number);
    assert.ok(observation.claim_messages?.some(m=>detail.messages.some(saved=>saved.raw_data.hash===m.key && saved.text===m.text)));
    console.log('Caso 5589264783: dados persistidos, vínculo por claim, mensagens, timeline e endpoints oficiais OK. Somente leitura.');
  } finally { globalThis.fetch=originalFetch; }
}
main().catch(()=>{console.error('Validação do caso falhou; nenhuma alteração remota executada. Verifique credenciais e dados locais.');process.exitCode=1;});
