-- Keep the commercial sale independent from payment snapshots.
alter table public.venda alter column valor_liquido drop not null;

-- Statement movements may share SOURCE_ID when the official transaction types differ.
alter table public.financial_statement_entries add column transaction_type text;
do $$
declare
  identity_constraint record;
begin
  for identity_constraint in
    select conname
      from pg_constraint
     where conrelid = 'public.financial_statement_entries'::regclass
       and contype = 'u'
       and pg_get_constraintdef(oid) = 'UNIQUE (account_id, source, semantic, external_id, payload_sha256)'
  loop
    execute format('alter table public.financial_statement_entries drop constraint %I', identity_constraint.conname);
  end loop;
end;
$$;
alter table public.financial_statement_entries
  add constraint financial_statement_entries_movement_identity_key
  unique nulls not distinct (account_id, source, semantic, external_id, transaction_type, payload_sha256);
create index financial_statement_entries_transaction_type_idx
  on public.financial_statement_entries(account_id, source, transaction_type, occurred_at);
comment on column public.financial_statement_entries.transaction_type is
  'Literal official Mercado Livre transaction_type (SETTLEMENT, DISPUTE, SETTLEMENT_SHIPPING, DISPUTE_SHIPPING, REFUND, CASHBACK); other source codes and NULL remain valid.';

-- Current financial representation, separate from commercial sale rows.
create table public.marketplace_payment_finance (
  account_id uuid not null references public.config_marketplace_accounts(id) on delete restrict,
  payment_id text not null check (length(btrim(payment_id)) > 0),
  sale_id uuid references public.venda(id) on delete set null,
  order_id_official text not null check (length(btrim(order_id_official)) > 0),
  source_id text,
  operation_id text,
  currency text,
  status text not null,
  approved_at timestamptz,
  predicted_release_at timestamptz,
  effective_release_at timestamptz,
  transaction_amount numeric(14,2),
  transaction_amount_refunded numeric(14,2),
  net_received_amount numeric(14,2),
  shipping_amount numeric(14,2),
  official_identifiers jsonb not null default '[]'::jsonb,
  original_references jsonb not null default '{}'::jsonb,
  current_snapshot jsonb not null,
  source_activity_id text,
  api_updated_at timestamptz,
  observed_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (account_id, payment_id),
  check (jsonb_typeof(official_identifiers) = 'array'),
  check (jsonb_typeof(original_references) = 'object'),
  check (jsonb_typeof(current_snapshot) = 'object')
);
create index marketplace_payment_finance_sale_idx on public.marketplace_payment_finance(sale_id);
create index marketplace_payment_finance_order_idx on public.marketplace_payment_finance(account_id, order_id_official);

-- Immutable distinct observations preserve every prior financial representation.
create table public.marketplace_payment_finance_history (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.config_marketplace_accounts(id) on delete restrict,
  payment_id text not null,
  sale_id uuid references public.venda(id) on delete set null,
  order_id_official text not null,
  observed_at timestamptz not null,
  api_updated_at timestamptz,
  source_activity_id text,
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  unique (account_id, payment_id, snapshot)
);
create index marketplace_payment_finance_history_lookup_idx
  on public.marketplace_payment_finance_history(account_id, payment_id, observed_at desc);

alter table public.marketplace_payment_finance enable row level security;
alter table public.marketplace_payment_finance force row level security;
alter table public.marketplace_payment_finance_history enable row level security;
alter table public.marketplace_payment_finance_history force row level security;
revoke all on public.marketplace_payment_finance, public.marketplace_payment_finance_history
  from public, anon, authenticated, service_role;
grant select on public.marketplace_payment_finance, public.marketplace_payment_finance_history to service_role;

create or replace function public.persist_mercado_livre_payment_finance(
  p_marketplace_account_id uuid,
  p_seller_id text,
  p_order_id text,
  p_expected_payment_ids jsonb,
  p_payment_observations jsonb,
  p_financial_capture jsonb,
  p_allow_net_update boolean,
  p_activity_id text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  account_row public.config_marketplace_accounts%rowtype;
  payment_item jsonb;
  candidate_sale_id uuid;
  linked_sale_id uuid;
  candidate_count integer;
  payment_count integer := 0;
  payment_key text;
  currency_id text;
  incoming_api_version timestamptz;
  current_snapshot jsonb;
  clean_snapshot jsonb;
  official_identifiers jsonb;
  references_json jsonb;
  order_identifiers jsonb;
  operation_item jsonb;
  operation_key text;
begin
  if p_marketplace_account_id is null or nullif(btrim(p_seller_id), '') is null
     or nullif(btrim(p_order_id), '') is null
     or jsonb_typeof(p_expected_payment_ids) is distinct from 'array'
     or jsonb_typeof(p_payment_observations) is distinct from 'array'
     or jsonb_typeof(p_financial_capture) is distinct from 'object' then
    raise exception 'Identidade ou observacao financeira invalida';
  end if;

  select * into strict account_row
    from public.config_marketplace_accounts
   where id = p_marketplace_account_id and marketplace = 'mercado_livre';
  if coalesce(nullif(account_row.seller_id, ''), nullif(account_row.account_id, '')) is distinct from p_seller_id then
    raise exception 'Seller diverge da conta Mercado Livre';
  end if;

  order_identifiers := case when jsonb_typeof(p_financial_capture->'order_identifiers') = 'array'
    then p_financial_capture->'order_identifiers' else '[]'::jsonb end;
  references_json := case when jsonb_typeof(p_financial_capture->'original_references') = 'object'
    then p_financial_capture->'original_references' else '{}'::jsonb end;

  -- Match only explicit official identifiers or the account-scoped official ORDER_ID.
  -- Multiple candidate sales are intentionally left pending.
  with requested as (
    select value->>'identifierType' as identifier_type, value->>'identifierValue' as identifier_value
      from jsonb_array_elements(order_identifiers)
     where nullif(value->>'identifierType', '') is not null
       and nullif(value->>'identifierValue', '') is not null
  ), candidates as (
    select distinct i.venda_id
      from public.venda_financeiro_identificadores i
      join requested r on r.identifier_type = i.identifier_type and r.identifier_value = i.identifier_value
     where i.marketplace_account_id = p_marketplace_account_id
    union
    select v.id
      from public.venda v
     where v.marketplace = 'mercado_livre'
       and v.order_id = p_order_id
       and v.raw_data->>'marketplace_account_id' = p_marketplace_account_id::text
  )
  select count(*), min(venda_id::text)::uuid into candidate_count, candidate_sale_id from candidates;
  if candidate_count = 1 then linked_sale_id := candidate_sale_id; else linked_sale_id := null; end if;

  if linked_sale_id is not null and jsonb_array_length(order_identifiers) > 0 then
    perform public.persist_sale_financial_identifiers(
      linked_sale_id, p_marketplace_account_id, 'mercado_livre.payments', order_identifiers
    );
  end if;

  for payment_item in select value from jsonb_array_elements(p_payment_observations) loop
    payment_key := nullif(btrim(payment_item->>'id'), '');
    currency_id := nullif(payment_item->>'currency_id', '');
    if payment_key is null or nullif(payment_item->>'status', '') is null
       or nullif(payment_item->>'observed_at', '') is null
       or currency_id is null
       or payment_item->>'id' not in (select jsonb_array_elements_text(p_expected_payment_ids)) then
      raise exception 'Snapshot de pagamento sem identidade oficial completa';
    end if;

    clean_snapshot := payment_item - 'observed_at' - 'source_activity_id';
    clean_snapshot := clean_snapshot || jsonb_build_object('order_id_official', p_order_id);
    incoming_api_version := nullif(payment_item->>'api_updated_at', '')::timestamptz;
    current_snapshot := null;
    select f.current_snapshot into current_snapshot
      from public.marketplace_payment_finance f
     where f.account_id = p_marketplace_account_id and f.payment_id = payment_key
     for update;

    if current_snapshot is null or clean_snapshot is distinct from (current_snapshot - 'observed_at' - 'source_activity_id')
       then
      insert into public.marketplace_payment_finance_history
        (account_id, payment_id, sale_id, order_id_official, observed_at, api_updated_at, source_activity_id, snapshot)
      values
        (p_marketplace_account_id, payment_key, linked_sale_id, p_order_id,
         (payment_item->>'observed_at')::timestamptz, incoming_api_version, p_activity_id, clean_snapshot)
      on conflict (account_id, payment_id, snapshot) do nothing;
    end if;

    official_identifiers := jsonb_build_array(jsonb_build_object('identifierType','PAYMENT_ID','identifierValue',payment_key));
    if nullif(payment_item->>'source_id','') is not null then
      official_identifiers := official_identifiers || jsonb_build_array(jsonb_build_object('identifierType','SOURCE_ID','identifierValue',payment_item->>'source_id'));
    end if;
    if nullif(payment_item->>'operation_id','') is not null then
      official_identifiers := official_identifiers || jsonb_build_array(jsonb_build_object('identifierType','OPERATION_ID','identifierValue',payment_item->>'operation_id'));
    end if;
    if jsonb_typeof(payment_item->'operation_ids') = 'array' then
      for operation_item in select value from jsonb_array_elements(payment_item->'operation_ids') loop
        operation_key := case jsonb_typeof(operation_item)
          when 'string' then operation_item #>> '{}'
          when 'number' then operation_item #>> '{}'
          when 'object' then operation_item->>'id'
          else null
        end;
        if nullif(btrim(operation_key), '') is not null then
          official_identifiers := official_identifiers || jsonb_build_array(jsonb_build_object('identifierType','OPERATION_ID','identifierValue',btrim(operation_key)));
        end if;
      end loop;
    end if;

    insert into public.marketplace_payment_finance as current
      (account_id, payment_id, sale_id, order_id_official, source_id, operation_id,
       currency, status, approved_at, predicted_release_at, effective_release_at,
       transaction_amount, transaction_amount_refunded, net_received_amount, shipping_amount,
       official_identifiers, original_references, current_snapshot, source_activity_id, api_updated_at, observed_at, updated_at)
    values
      (p_marketplace_account_id, payment_key, linked_sale_id, p_order_id,
       nullif(payment_item->>'source_id',''), nullif(payment_item->>'operation_id',''), currency_id,
       payment_item->>'status', nullif(payment_item->>'date_approved','')::timestamptz,
       case when payment_item->>'money_release_status' is distinct from 'released'
         then nullif(payment_item->>'money_release_date','')::timestamptz end,
       case when payment_item->>'money_release_status' = 'released'
         then nullif(payment_item->>'money_release_date','')::timestamptz end,
       nullif(payment_item->>'transaction_amount','')::numeric,
       nullif(payment_item->>'transaction_amount_refunded','')::numeric,
       nullif(payment_item->>'net_received_amount','')::numeric,
       nullif(payment_item->>'shipping_amount','')::numeric,
       official_identifiers, references_json, clean_snapshot, p_activity_id, incoming_api_version,
       (payment_item->>'observed_at')::timestamptz, now())
    on conflict (account_id, payment_id) do update set
      sale_id = coalesce(excluded.sale_id, current.sale_id),
      order_id_official = excluded.order_id_official,
      source_id = coalesce(excluded.source_id, current.source_id),
      operation_id = coalesce(excluded.operation_id, current.operation_id),
      official_identifiers = current.official_identifiers || excluded.official_identifiers,
      original_references = jsonb_set(
        current.original_references || excluded.original_references,
        '{reference_history}',
        (select coalesce(jsonb_agg(distinct value), '[]'::jsonb)
           from jsonb_array_elements(
             coalesce(current.original_references->'reference_history','[]'::jsonb)
             || coalesce(excluded.original_references->'reference_history','[]'::jsonb)
             || case when current.original_references - 'reference_history' <> '{}'::jsonb
                 then jsonb_build_array(current.original_references - 'reference_history') else '[]'::jsonb end
             || case when excluded.original_references - 'reference_history' <> '{}'::jsonb
                 then jsonb_build_array(excluded.original_references - 'reference_history') else '[]'::jsonb end
           ) as refs(value)), true),
      currency = case when (excluded.api_updated_at is null and current.api_updated_at is null) or (excluded.api_updated_at is not null and (current.api_updated_at is null or excluded.api_updated_at >= current.api_updated_at)) then excluded.currency else current.currency end,
      status = case when (excluded.api_updated_at is null and current.api_updated_at is null) or (excluded.api_updated_at is not null and (current.api_updated_at is null or excluded.api_updated_at >= current.api_updated_at)) then excluded.status else current.status end,
      approved_at = case when (excluded.api_updated_at is null and current.api_updated_at is null) or (excluded.api_updated_at is not null and (current.api_updated_at is null or excluded.api_updated_at >= current.api_updated_at)) then excluded.approved_at else current.approved_at end,
      predicted_release_at = case when (excluded.api_updated_at is null and current.api_updated_at is null) or (excluded.api_updated_at is not null and (current.api_updated_at is null or excluded.api_updated_at >= current.api_updated_at)) then excluded.predicted_release_at else current.predicted_release_at end,
      effective_release_at = case when (excluded.api_updated_at is null and current.api_updated_at is null) or (excluded.api_updated_at is not null and (current.api_updated_at is null or excluded.api_updated_at >= current.api_updated_at)) then excluded.effective_release_at else current.effective_release_at end,
      transaction_amount = case when (excluded.api_updated_at is null and current.api_updated_at is null) or (excluded.api_updated_at is not null and (current.api_updated_at is null or excluded.api_updated_at >= current.api_updated_at)) then excluded.transaction_amount else current.transaction_amount end,
      transaction_amount_refunded = case when (excluded.api_updated_at is null and current.api_updated_at is null) or (excluded.api_updated_at is not null and (current.api_updated_at is null or excluded.api_updated_at >= current.api_updated_at)) then excluded.transaction_amount_refunded else current.transaction_amount_refunded end,
      net_received_amount = case when (excluded.api_updated_at is null and current.api_updated_at is null) or (excluded.api_updated_at is not null and (current.api_updated_at is null or excluded.api_updated_at >= current.api_updated_at)) then excluded.net_received_amount else current.net_received_amount end,
      shipping_amount = case when (excluded.api_updated_at is null and current.api_updated_at is null) or (excluded.api_updated_at is not null and (current.api_updated_at is null or excluded.api_updated_at >= current.api_updated_at)) then excluded.shipping_amount else current.shipping_amount end,
      current_snapshot = case when (excluded.api_updated_at is null and current.api_updated_at is null) or (excluded.api_updated_at is not null and (current.api_updated_at is null or excluded.api_updated_at >= current.api_updated_at)) then excluded.current_snapshot else current.current_snapshot end,
      source_activity_id = case when (excluded.api_updated_at is null and current.api_updated_at is null) or (excluded.api_updated_at is not null and (current.api_updated_at is null or excluded.api_updated_at >= current.api_updated_at)) then excluded.source_activity_id else current.source_activity_id end,
      api_updated_at = greatest(current.api_updated_at, excluded.api_updated_at),
      observed_at = greatest(current.observed_at, excluded.observed_at),
      updated_at = now();
    payment_count := payment_count + 1;
  end loop;

  return jsonb_build_object('persisted', true, 'sale_id', linked_sale_id,
    'link_status', case when linked_sale_id is null then 'pending' else 'linked' end,
    'payment_count', payment_count, 'source_activity_id', p_activity_id);
end;
$$;

revoke all on function public.persist_mercado_livre_payment_finance(uuid, text, text, jsonb, jsonb, jsonb, boolean, text)
  from public, anon, authenticated;
grant execute on function public.persist_mercado_livre_payment_finance(uuid, text, text, jsonb, jsonb, jsonb, boolean, text)
  to service_role;

-- A crashed payments handler must become a visible pending error, never an automatic retry.
create or replace function public.claim_marketplace_activity_queue(p_limit integer default 10)
returns setof public.marketplace_activities
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  update public.marketplace_activities
     set status = 'error',
         processing_error = coalesce(processing_error, 'Webhook payments interrompido; requer ação explícita.'),
         processed_at = null,
         processing_started_at = null,
         locked_at = null
   where status = 'processing'
     and locked_at < now() - interval '10 minutes'
     and marketplace = 'mercado_livre'
     and coalesce(
       coalesce(raw_payload->'notification', raw_payload)->>'topic',
       coalesce(raw_payload->'notification', raw_payload)->>'type'
     ) = 'payments';

  return query
  with candidates as (
    select id
      from public.marketplace_activities
     where (status in ('queued', 'retry') and next_attempt_at <= now())
        or (status = 'processing' and locked_at < now() - interval '10 minutes'
            and not (marketplace = 'mercado_livre'
              and coalesce(
                coalesce(raw_payload->'notification', raw_payload)->>'topic',
                coalesce(raw_payload->'notification', raw_payload)->>'type'
              ) = 'payments'))
     order by (event_type = 'case_reconcile') nulls first, received_at, id
     for update skip locked
     limit greatest(1, least(coalesce(p_limit, 10), 50))
  )
  update public.marketplace_activities activity
     set status = 'processing',
         attempt_count = activity.attempt_count + 1,
         processing_started_at = now(),
         locked_at = now(),
         processing_error = null
    from candidates
   where activity.id = candidates.id
  returning activity.*;
end;
$$;
