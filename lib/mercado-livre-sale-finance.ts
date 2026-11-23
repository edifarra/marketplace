type Row = Record<string, any>;
// Decimal cents: monetary fields remain null when absent or not representable.
export function financialCents(value: unknown): number | null {
  if (value == null || value === '') return null;
  const match = String(value).match(/^(-?)(\d+)(?:\.(\d{1,2})(0*))?$/);
  if (!match) return null;
  const amount = Number(match[2]) * 100 + Number((match[3] || '').padEnd(2, '0'));
  return Number.isSafeInteger(amount) ? (match[1] ? -amount : amount) : null;
}
// Only terminal attempts with an explicit zero receipt and no approval,
// release or refund evidence may be ignored when proving a sale-level release.
// Missing or contradictory API fields leave the attempt relevant (fail-closed).
export function isNonReceivingTerminalPayment(payment: Row): boolean {
  if (!['cancelled', 'rejected'].includes(String(payment.status || ''))) return false;
  if (financialCents(payment.net_received_amount) !== 0) return false;
  const refunded = payment.transaction_amount_refunded;
  if (refunded != null && financialCents(refunded) !== 0) return false;
  if (payment.date_approved != null && payment.date_approved !== '') return false;
  if (payment.money_release_status === 'released') return false;
  if (payment.money_release_date != null && payment.money_release_date !== '') return false;
  return true;
}
export function paymentReleaseClass(payment: Row): 'excluded_no_receipt' | 'blocked_terminal_ambiguous' | 'requires_release' {
  if (!['cancelled', 'rejected'].includes(String(payment.status || ''))) return 'requires_release';
  return isNonReceivingTerminalPayment(payment) ? 'excluded_no_receipt' : 'blocked_terminal_ambiguous';
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
  const orderPaymentIds = ids;
  const orderApiUpdatedAt = validTimestamp(order.date_last_updated || order.last_updated);
  if(ids.length>20) return { state:'partial', errors:[{code:'payment_limit'}], payments, commercial_net:null, approved_at:approvalDate(order.payments || []), effective_release_at:null, order_payment_ids:orderPaymentIds, order_api_updated_at:orderApiUpdatedAt };
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
  let net=0, complete=ids.length>0 && !errors.length && payments.some(p=>p.status==='approved');
  for(const p of payments) {
    if (['cancelled','rejected'].includes(p.status)) { p.commercial_net_cents=0; continue; }
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
  const releaseObservations = new Map(payments.map(payment => [String(payment.id), payment]));
  let hasAmbiguousTerminal = false;
  const relevantIds = ids.filter(id => {
    const payment = releaseObservations.get(id);
    if (!payment) return true;
    const classification = paymentReleaseClass(payment);
    if (classification === 'blocked_terminal_ambiguous') hasAmbiguousTerminal = true;
    return classification !== 'excluded_no_receipt';
  });
  const releasedDates = relevantIds.map(id => {
    const payment = releaseObservations.get(id);
    return payment?.money_release_status === 'released' ? validTimestamp(payment.money_release_date) : null;
  });
  const effectiveReleaseAt = relevantIds.length > 0 && !hasAmbiguousTerminal
    && releasedDates.every((date): date is string => date !== null)
    ? new Date(Math.max(...releasedDates.map(date => Date.parse(date)))).toISOString()
    : null;
  return {state:complete?'complete':'partial',payments,errors,commercial_net:complete?net/100:null,
    approved_at:approvalDate([...(order.payments || []),...payments]),effective_release_at:effectiveReleaseAt,
    order_payment_ids:orderPaymentIds,order_api_updated_at:orderApiUpdatedAt,
    collected_at:new Date().toISOString(),basis:'original collector charges; snapshot is not a statement movement',
    release_limitation:effectiveReleaseAt ? 'all expected payments report released with valid money_release_date' : 'effective release is not proven until all expected payments report released with valid money_release_date'};
}

function validTimestamp(value: unknown) {
  if (typeof value !== 'string' || !/(Z|[+-]\d{2}:?\d{2})$/i.test(value) || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}


// Historical formula values alone are never evidence of reconciliation.
export function confirmedSaleFinance(value?: unknown): Row | undefined {
  const capture = value && typeof value === "object" && !Array.isArray(value) ? value as Row : undefined;
  const valid=(value?:Row)=>value?.state==='complete' && financialCents(value.commercial_net)!==null
    && (!value.errors || (Array.isArray(value.errors) && value.errors.length===0));
  if(valid(capture)) return capture;
  if(valid(capture?.previous_success)) return capture!.previous_success;
  // Compatibility with the existing payment RPC's compact previous_success.
  const legacy=capture?.previous_success;
  if (legacy?.state == null && financialCents(legacy?.commercial_net)!==null
      && legacy?.basis==='original collector charges; snapshot is not a statement movement'
      && validTimestamp(legacy.collected_at)) return legacy;
  return undefined;
}
function olderCapture(incoming:Row, previous:Row) {
  return (previous.payments || []).some((p:Row)=>{
    const next=(incoming.payments || []).find((n:Row)=>String(n.id)===String(p.id));
    const before=validTimestamp(p.api_updated_at), after=validTimestamp(next?.api_updated_at);
    return !next || (before && (!after || Date.parse(after)<Date.parse(before)));
  });
}
export function saleFinancialPatch(input:{finance?:Row;paidAt?:string|null},previous:Row) {
  const finance=input.finance;
  const previousSuccess=confirmedSaleFinance(previous.financial_capture);
  const incoming=finance?.state==='complete' ? confirmedSaleFinance(finance) : undefined;
  const success=incoming && (!previousSuccess || !olderCapture(incoming,previousSuccess)) ? incoming : previousSuccess;
  const raw=success===incoming && incoming ? incoming : {
    ...(finance || previous.financial_capture || {}), state:'partial', commercial_net:null,
    reconciliation_status:success ? 'previous_confirmed' : 'pending',
    previous_success:success || null
  };
  return {
    ...(input.paidAt ? {data_pagamento:input.paidAt} : {}),
    // Technical NOT NULL placeholder, explicitly pending in raw and UI.
    valor_liquido:success ? Number(success.commercial_net) : 0, raw
  };
}

// Displayed order freight is informational, never a fallback for commercial net.
export function approvedOrderShipping(payments: Row[]): number {
  const seen = new Set<string>();
  let cents = 0;
  for (const payment of payments) {
    if (payment.status !== 'approved') continue;
    const id = String(payment.id || '');
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    cents += financialCents(payment.shipping_cost) ?? 0;
  }
  return cents / 100;
}

// A pending ML sale makes the aggregate unavailable, rather than a false total.
// Other marketplaces retain the existing dashboard calculation.
export function saleNetTotal(sales: Row[]): number | null {
  let total = 0;
  for (const sale of sales) {
    if (sale.marketplace === 'mercado_livre') {
      const capture = confirmedSaleFinance(sale.raw_data?.financial_capture);
      if (!capture) return null;
      total += Number(capture.commercial_net);
    } else {
      total += Number(sale.valor_produtos || 0) - Number(sale.valor_taxas || 0)
        - Number(sale.valor_descontos || 0) - Number(sale.valor_frete || 0);
    }
  }
  return total;
}
