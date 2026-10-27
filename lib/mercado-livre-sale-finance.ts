type Row = Record<string, any>;
// Decimal cents: monetary fields remain null when absent or not representable.
export function financialCents(value: unknown): number | null {
  if (value == null || value === '') return null;
  const match = String(value).match(/^(-?)(\d+)(?:\.(\d{1,2})(0*))?$/);
  if (!match) return null;
  const amount = Number(match[2]) * 100 + Number((match[3] || '').padEnd(2, '0'));
  return Number.isSafeInteger(amount) ? (match[1] ? -amount : amount) : null;
}
export function approvalDate(payments: Row[]): string | null {
  const dates=payments.filter(p=>['approved','refunded','in_mediation','charged_back'].includes(p.status))
    .map(p=>p.date_approved).filter(d=>typeof d==='string' && /(Z|[+-]\d{2}:?\d{2})$/.test(d) && Number.isFinite(Date.parse(d)));
  // First approved payment, not a claim that every installment is paid.
  return dates.length ? new Date(Math.min(...dates.map(d=>Date.parse(d)))).toISOString() : null;
}
export async function captureSaleFinance(order: Row, sellerId: string, read: (id: string)=>Promise<Row>) {
  const payments: Row[]=[], errors: Row[]=[];
  const ids=[...new Set<string>((order.payments || []).filter((p:Row)=>['approved','refunded','in_mediation','charged_back'].includes(p.status)).map((p:Row)=>String(p.id)))];
  if(ids.length>20) return { state:'partial', errors:[{code:'payment_limit'}], payments, commercial_net:null, approved_at:approvalDate(order.payments || []), effective_release_at:null };
  for(let offset=0;offset<ids.length;offset+=3) await Promise.all(ids.slice(offset,offset+3).map(async id=>{
    try {
      const p=await read(id);
      if(String(p.id)!==id || String(p.collector_id)!==sellerId || p.order?.type!=='mercadolibre' || String(p.order?.id)!==String(order.id) || p.currency_id!==order.currency_id || !['approved','refunded','in_mediation','charged_back'].includes(p.status)) throw new Error('identity');
      const charges=Array.isArray(p.charges_details) ? p.charges_details.map((c:Row)=>({ id:String(c.id || ''), name:c.name, type:c.type, accounts:c.accounts, amounts:c.amounts })) : null;
      payments.push({id,status:p.status,currency_id:p.currency_id,date_approved:p.date_approved,money_release_date:p.money_release_date,money_release_status:p.money_release_status,
        net_received_amount:p.transaction_details?.net_received_amount ?? null,transaction_amount:p.transaction_amount,transaction_amount_refunded:p.transaction_amount_refunded ?? null,shipping_amount:p.shipping_amount ?? p.shipping_cost,charges});
    } catch(e) { errors.push({payment_id:id,endpoint:`/v1/payments/${id}`,code:e instanceof Error && e.message==='identity' ? 'identity_mismatch' : 'payment_unavailable'}); }
  }));
  payments.sort((a,b)=>a.id.localeCompare(b.id));
  let net=0, complete=ids.length>0 && !errors.length;
  for(const p of payments) {
    if(p.status!=='approved' || (p.transaction_amount_refunded!=null && financialCents(p.transaction_amount_refunded)!==0)) {
      complete=false;
      errors.push({payment_id:p.id,code:'original_commercial_net_not_proved_after_refund_or_dispute'});
    }
    const gross=financialCents(p.transaction_amount), shipping=financialCents(p.shipping_amount);
    if(gross===null || shipping===null || !p.charges) { complete=false; continue; }
    let current=gross+shipping;
    const seen=new Set();
    for(const c of p.charges) {
      const amount=financialCents(c.amounts?.original);
      if(!c.id || seen.has(c.id) || amount===null || amount<0) {complete=false;continue;} seen.add(c.id);
      const from=c.accounts?.from==='collector',to=c.accounts?.to==='collector';
      if(from && !to) current-=amount;
      else if(to && !from) current+=amount;
      else if(from===to) { complete=false; }
    }
    // For an unrefunded payment the source snapshot must corroborate the
    // component formula. Unknown deductions never become a fabricated liquid.
    if(p.status==='approved' && financialCents(p.net_received_amount)!==current) complete=false;
    net+=current;
  }
  return {state:complete?'complete':'partial',payments,errors,commercial_net:complete?net/100:null,
    approved_at:approvalDate([...(order.payments || []),...payments]),effective_release_at:null,
    collected_at:new Date().toISOString(),basis:'original collector charges; snapshot is not a statement movement',
    release_limitation:'money_release_date is forecast; effective release is not proved by this source'};
}

// Keep a successful earlier observation on a later natural trigger whose API
// lookup fails. This does not schedule or perform any later synchronization.
export function saleFinancialPatch(input: {finance?:Row;paidAt?:string|null}, previous:Row) {
  const finance=input.finance;
  const previousSuccess=previous.financial_capture?.commercial_net!=null ? previous.financial_capture : previous.financial_capture?.previous_success;
  return {
    ...(input.paidAt ? {data_pagamento:input.paidAt} : {}),
    ...(finance?.commercial_net!=null ? {valor_liquido:finance.commercial_net} : previousSuccess?.commercial_net!=null ? {valor_liquido:previousSuccess.commercial_net} : {}),
    raw: finance ? {...finance,...(finance.commercial_net==null && previousSuccess ? {previous_success:previousSuccess} : {})} : previous.financial_capture
  };
}
