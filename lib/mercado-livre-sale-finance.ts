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
  const ids=[...new Set<string>((order.payments || []).map((p:Row)=>String(p.id || '')).filter(Boolean))];
  if(ids.length>20) return { state:'partial', errors:[{code:'payment_limit'}], payments, commercial_net:null, approved_at:approvalDate(order.payments || []), effective_release_at:null };
  for(let offset=0;offset<ids.length;offset+=3) await Promise.all(ids.slice(offset,offset+3).map(async id=>{
    try {
      const p=await read(id);
      if(String(p.id)!==id || String(p.collector_id)!==sellerId || p.order?.type!=='mercadolibre' || String(p.order?.id)!==String(order.id) || p.currency_id!==order.currency_id || typeof p.status!=='string' || !p.status) throw new Error('identity');
      const charges=Array.isArray(p.charges_details) ? p.charges_details.map((c:Row)=>({ id:String(c.id || ''), name:c.name, type:c.type, accounts:c.accounts, amounts:c.amounts })) : null;
      payments.push({id,status:p.status,currency_id:p.currency_id,date_approved:p.date_approved,money_release_date:p.money_release_date,money_release_status:p.money_release_status,
        api_updated_at:validTimestamp(p.date_last_updated), observed_at:new Date().toISOString(),
        net_received_amount:p.transaction_details?.net_received_amount ?? null,transaction_amount:p.transaction_amount,transaction_amount_refunded:p.transaction_amount_refunded ?? null,shipping_amount:p.shipping_amount ?? p.shipping_cost,charges});
    } catch(e) { errors.push({payment_id:id,endpoint:`/v1/payments/${id}`,code:e instanceof Error && e.message==='identity' ? 'identity_mismatch' : 'payment_unavailable'}); }
  }));
  payments.sort((a,b)=>a.id.localeCompare(b.id));
  let net=0, complete=ids.length>0 && !errors.length;
  for(const p of payments) {
    let paymentComplete=p.status==='approved' && (p.transaction_amount_refunded==null || financialCents(p.transaction_amount_refunded)===0);
    const gross=financialCents(p.transaction_amount), shipping=financialCents(p.shipping_amount);
    if(gross===null || shipping===null || !p.charges) { complete=false; paymentComplete=false; p.commercial_net_cents=null; continue; }
    let current=gross+shipping;
    const seen=new Set();
    for(const c of p.charges) {
      const amount=financialCents(c.amounts?.original);
      if(!c.id || seen.has(c.id) || amount===null || amount<0) {complete=false;paymentComplete=false;continue;} seen.add(c.id);
      const from=c.accounts?.from==='collector',to=c.accounts?.to==='collector';
      if(from && !to) current-=amount;
      else if(to && !from) current+=amount;
      else if(from===to) { complete=false;paymentComplete=false; }
    }
    // For an unrefunded payment the source snapshot must corroborate the
    // component formula. Unknown deductions never become a fabricated liquid.
    if(p.status==='approved' && financialCents(p.net_received_amount)!==current) {complete=false;paymentComplete=false;}
    if(p.status!=='approved') {complete=false;paymentComplete=false;}
    if(!paymentComplete) complete=false;
    p.commercial_net_cents=paymentComplete ? current : null;
    net+=current;
  }
  const expected = new Set(ids);
  const releaseObservations = new Map(payments.map(payment => [String(payment.id), payment]));
  const releasedDates = ids.map(id => {
    const payment = releaseObservations.get(id);
    return payment?.money_release_status === 'released' ? validTimestamp(payment.money_release_date) : null;
  });
  const effectiveReleaseAt = ids.length > 0 && expected.size === releasedDates.length
    && releasedDates.every((date): date is string => date !== null)
    ? new Date(Math.max(...releasedDates.map(date => Date.parse(date)))).toISOString()
    : null;
  return {state:complete?'complete':'partial',payments,errors,commercial_net:complete?net/100:null,
    approved_at:approvalDate([...(order.payments || []),...payments]),effective_release_at:effectiveReleaseAt,
    collected_at:new Date().toISOString(),basis:'original collector charges; snapshot is not a statement movement',
    release_limitation:effectiveReleaseAt ? 'all expected payments report released with valid money_release_date' : 'effective release is not proven until all expected payments report released with valid money_release_date'};
}

function validTimestamp(value: unknown) {
  if (typeof value !== 'string' || !/(Z|[+-]\d{2}:?\d{2})$/i.test(value) || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
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
