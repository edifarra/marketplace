import { createHash } from 'node:crypto';
export const START = '2026-10-01T03:00:00.000Z';
export const MAX_END = '2026-10-26T03:00:00.000Z';
export const sha = value => createHash('sha256').update(value).digest('hex');
// Numeric lexemes remain strings: no rounding of 18-digit Shopee IDs or decimals.
// The response bytes, including original JSON number types, are stored separately.
export function parseLossless(text) {
  return JSON.parse(text, (_key, value, context) => typeof value === 'number' ? context.source : value);
}
export function period(end) {
  const parsed = new Date(end);
  if (!Number.isFinite(+parsed) || +parsed <= Date.parse(START) || +parsed > Date.parse(MAX_END) || +parsed > Date.now()) throw new Error('End must be in October 1..25, 2026, and not in the future.');
  return { start: START, end: parsed.toISOString() };
}
export function inPeriod(date, window) {
  return Number.isFinite(Date.parse(date)) && Date.parse(date) >= Date.parse(window.start) && Date.parse(date) < Date.parse(window.end);
}
export const decimal = value => typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value) ? value : null;
export function signed(value, flow) {
  const amount = decimal(value);
  if (amount === null) return null;
  if (flow === 'MONEY_OUT') return '-' + amount.replace(/^-/, '');
  if (flow === 'MONEY_IN') return amount.replace(/^-/, '');
  return amount;
}
export function amounts(value, prefix = '', result = {}) {
  if (!value || typeof value !== 'object') return result;
  for (const [key, item] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (item && typeof item === 'object') amounts(item, path, result);
    else if (/amount|fee|rebate|balance|income|price|refund|commission|payout|escrow|tax/i.test(key) && decimal(item) !== null) result[path] = item;
  }
  return result;
}
// RFC4180 plus MP's quoted JSON dialect (JSON quotes are not always doubled).
// Accept that extension only when the entire field is valid JSON. Never strip
// arbitrary inner quotes to make a malformed record appear valid.
export function csvRecords(text, separator = ',') {
  if (typeof separator !== 'string' || separator.length !== 1 || /["\r\n]/.test(separator)) throw new Error('Invalid CSV separator');
  const records = []; let fields = [], start = 0, i = 0;
  const boundary = c => c === undefined || c === separator || c === '\r' || c === '\n';
  while (i < text.length) {
    let field = '';
    if (text[i] === '"') {
      const begin = ++i;
      let closed = false;
      if (text[i] === '[' || text[i] === '{') {
        for (; i < text.length; i++) {
          if (text[i] !== '"' || !boundary(text[i + 1])) continue;
          const raw = text.slice(begin, i);
          for (const candidate of [raw, raw.replaceAll('""', '"')]) {
            try { JSON.parse(candidate); field = candidate; closed = true; break; } catch { /* Try next closing boundary. */ }
          }
          if (closed) { i++; break; }
        }
      } else {
        for (; i < text.length; i++) {
          if (text[i] !== '"') { field += text[i]; continue; }
          if (text[i + 1] === '"') { field += '"'; i++; continue; }
          if (!boundary(text[i + 1])) throw new Error('Malformed CSV quote');
          i++; closed = true; break;
        }
      }
      if (!closed) throw new Error('Unterminated or invalid CSV quote/JSON');
    } else if (text[i] === '[' || text[i] === '{') {
      const begin=i;let valid=false;
      for(;i<=text.length;i++) {
        if(!boundary(text[i]))continue;
        const candidate=text.slice(begin,i);
        try{JSON.parse(candidate);field=candidate;valid=true;break;}catch{/* Delimiter may belong to JSON. */}
      }
      if(!valid)throw new Error('Invalid unquoted CSV JSON');
    } else {
      for (; i < text.length && !boundary(text[i]); i++) {
        if (text[i] === '"') throw new Error(`Unexpected CSV quote at offset ${i}, field ${fields.length}`);
        field += text[i];
      }
    }
    fields.push(field);
    if (text[i] === separator) { i++; if (i === text.length) fields.push(''); continue; }
    const end = i;
    if (text[i] === '\r') i++;
    if (text[i] === '\n') i++;
    records.push({ fields, raw: text.slice(start, end) }); fields = []; start = i;
  }
  if (fields.length) records.push({ fields, raw: text.slice(start) });
  return records.filter(r => r.raw.trim());
}
export function reportRows(text, separator) {
  const [header, ...records] = csvRecords(text.replace(/^\uFEFF/, ''), separator);
  if (!header || !header.fields.includes('TRANSACTION_DATE')) throw new Error('Unrecognized report header; bytes retained, no guessed mapping.');
  if (new Set(header.fields).size !== header.fields.length) throw new Error('Duplicate CSV header');
  return records.map(record => {
    if (record.fields.length !== header.fields.length) throw new Error('CSV width mismatch');
    return { payload: Object.fromEntries(header.fields.map((h, i) => [h, record.fields[i]])), raw: record.raw };
  });
}
export function reportMovementDate(payload) {
  // Settlement event/approval date in the chosen Transactions statement.
  // This is NOT proof of effective availability; MONEY_RELEASE_DATE is forecast.
  const date = payload.SETTLEMENT_DATE;
  if (!date || !/(Z|[+-]\d{2}:?\d{2})$/.test(date) || !Number.isFinite(Date.parse(date))) throw new Error('Missing/unzoned SETTLEMENT_DATE; original bytes retained');
  return date;
}

export function latestProcessedReport(reports) {
  const eligible = reports.filter(r => r.status === 'processed' && r.file_name);
  const rank = r => {
    const at = Date.parse(r.date_created || r.generation_date || '');
    if (!Number.isFinite(at) && !/^\d+$/.test(String(r.id || ''))) throw new Error('Report has no comparable version');
    return { at: Number.isFinite(at) ? at : 0, id: /^\d+$/.test(String(r.id)) ? BigInt(r.id) : 0n };
  };
  return [...eligible].sort((a,b) => { const x=rank(a),y=rank(b); return y.at-x.at || (y.id>x.id ? 1 : y.id<x.id ? -1 : String(a.file_name).localeCompare(String(b.file_name))); })[0] || null;
}

// Stable event key, independent of column order, CSV quoting and amount revisions.
// Repeated identities within a file retain their multiplicity. Values remain
// immutable observations; consumers select ONE report snapshot per coverage.
export function statementEventKey(payload, occurrence = 1) {
  if (!payload.SOURCE_ID || !payload.TRANSACTION_TYPE) throw new Error('Missing statement identity');
  return `${payload.SOURCE_ID}:${payload.TRANSACTION_TYPE}:${new Date(reportMovementDate(payload)).toISOString()}:${occurrence}`;
}

export function statementPayloadKey(payload) {
  const normalize = value => Array.isArray(value) ? value.map(normalize) : value && typeof value==='object' ? Object.fromEntries(Object.keys(value).sort().map(k=>[k,normalize(value[k])])) : value;
  return sha(JSON.stringify(Object.fromEntries(Object.keys(payload).sort().map(k=>{
    let v=payload[k];
    if(['METADATA','OPERATION_TAGS','TAXES_DISAGGREGATED'].includes(k) && v) {try{v=normalize(JSON.parse(v));}catch{/* Preserve unknown text. */}}
    return [k,v];
  }))));
}

export function selectStatementSnapshot(entries, membershipIds) {
  if (!Array.isArray(membershipIds)) throw new Error('Explicit statement snapshot membership required');
  const map=new Map(entries.map(e=>[e.id,e]));
  return [...new Set(membershipIds)].map(id=>{
    const entry=map.get(id);if(!entry || entry.source!=='mp_settlement_report')throw new Error('Missing statement snapshot member');return entry;
  });
}

export function planStatementImport(rows, previous, window) {
  const used=new Set(),occurrences=new Map();
  const sorted=[...rows].sort((a,b)=>statementEventKey(a.payload).localeCompare(statementEventKey(b.payload)) || statementPayloadKey(a.payload).localeCompare(statementPayloadKey(b.payload)));
  return sorted.filter(r=>inPeriod(reportMovementDate(r.payload),window)).map(row=>{
    const base=statementEventKey(row.payload),n=(occurrences.get(base)||0)+1;occurrences.set(base,n);
    const key=statementPayloadKey(row.payload);
    const reuse=previous.find(e=>!used.has(e.id) && e.original_line===row.raw)
      || previous.find(e=>!used.has(e.id) && statementPayloadKey(e.original_payload)===key);
    if(reuse)used.add(reuse.id);
    return {...row,externalId:statementEventKey(row.payload,n),reuseId:reuse?.id || null};
  });
}
