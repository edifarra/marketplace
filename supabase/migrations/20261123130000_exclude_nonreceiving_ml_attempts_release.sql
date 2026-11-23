-- Merge payment observations while holding the existing sale row lock.
-- This is required because separate payment webhooks for sibling payments may
-- be processed concurrently; a client-side read/merge/upsert can lose siblings.
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
security invoker
set search_path = public, pg_temp
as $$
declare
  sale_row public.venda%rowtype;
  account_row public.config_marketplace_accounts%rowtype;
  old_capture jsonb;
  payment_map jsonb := '{}'::jsonb;
  merged_capture jsonb;
  payment_item jsonb;
  previous_payment jsonb;
  expected_id text;
  incoming_version timestamptz;
  previous_version timestamptz;
  incoming_order_version timestamptz;
  previous_order_version timestamptz;
  incoming_expected_ids jsonb := '[]'::jsonb;
  stored_expected_ids jsonb;
  current_expected_ids jsonb := '[]'::jsonb;
  payment_count integer := 0;
  expected_count integer := 0;
  relevant_count integer := 0;
  release_count integer := 0;
  ambiguous_terminal_count integer := 0;
  aggregate_cents numeric := 0;
  aggregate_complete boolean := true;
  approved_at timestamptz;
  current_effective_release_at timestamptz;
  previous_effective_release_at timestamptz;
  previous_release_is_forecast boolean := false;
  non_receiving_terminal boolean;
begin
  if p_marketplace_account_id is null or nullif(p_seller_id, '') is null or nullif(p_order_id, '') is null
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

  select * into sale_row
    from public.venda
   where marketplace = 'mercado_livre' and order_id = p_order_id
   for update;
  if not found then raise exception 'Venda Mercado Livre nao cadastrada'; end if;
  if sale_row.raw_data->>'marketplace_account_id' is distinct from p_marketplace_account_id::text then
    raise exception 'Venda pertence a outra conta ou nao tem identidade verificavel';
  end if;

  old_capture := coalesce(sale_row.raw_data->'financial_capture', '{}'::jsonb);
  if jsonb_typeof(p_financial_capture->'order_payment_ids') = 'array' then
    select coalesce(jsonb_agg(to_jsonb(payment_id) order by payment_id), '[]'::jsonb)
      into incoming_expected_ids
      from (select distinct value as payment_id from jsonb_array_elements_text(p_financial_capture->'order_payment_ids') where value <> '') ids;
  else
    select coalesce(jsonb_agg(to_jsonb(payment_id) order by payment_id), '[]'::jsonb)
      into incoming_expected_ids
      from (select distinct value as payment_id from jsonb_array_elements_text(p_expected_payment_ids) where value <> '') ids;
  end if;
  stored_expected_ids := old_capture->'order_payment_ids';
  if jsonb_typeof(stored_expected_ids) is distinct from 'array' then stored_expected_ids := null; end if;
  begin
    if (p_financial_capture->>'order_api_updated_at') ~ '(Z|[+-][0-9]{2}:?[0-9]{2})$' then
      incoming_order_version := (p_financial_capture->>'order_api_updated_at')::timestamptz;
    end if;
  exception when others then incoming_order_version := null;
  end;
  begin
    if (old_capture->>'order_api_updated_at') ~ '(Z|[+-][0-9]{2}:?[0-9]{2})$' then
      previous_order_version := (old_capture->>'order_api_updated_at')::timestamptz;
    end if;
  exception when others then previous_order_version := null;
  end;
  if stored_expected_ids is null then
    -- Legacy captures have no authoritative stored order list. Preserve every
    -- known sibling on the first delivery, even when that delivery is incomplete.
    select coalesce(jsonb_agg(to_jsonb(payment_id) order by payment_id), '[]'::jsonb)
      into current_expected_ids
      from (
        select value as payment_id from jsonb_array_elements_text(incoming_expected_ids)
        union
        select key as payment_id from jsonb_object_keys(case
          when jsonb_typeof(old_capture->'payments_by_id') = 'object'
          then old_capture->'payments_by_id' else '{}'::jsonb end) as keys(key)
        where key <> ''
        union
        select value->>'id' as payment_id from jsonb_array_elements(case
          when jsonb_typeof(old_capture->'payments') = 'array'
          then old_capture->'payments' else '[]'::jsonb end)
        where nullif(value->>'id', '') is not null
      ) ids;
  elsif incoming_order_version is not null and (previous_order_version is null or incoming_order_version > previous_order_version) then
    current_expected_ids := incoming_expected_ids;
  else
    -- Same, older, or unavailable official order version: union IDs and fail
    -- closed rather than letting a stale/incomplete list erase a sibling.
    select coalesce(jsonb_agg(to_jsonb(payment_id) order by payment_id), '[]'::jsonb)
      into current_expected_ids
      from (
        select distinct value as payment_id from jsonb_array_elements_text(stored_expected_ids)
        union
        select distinct value as payment_id from jsonb_array_elements_text(incoming_expected_ids)
      ) ids;
  end if;
  if jsonb_typeof(old_capture->'payments_by_id') = 'object' then
    payment_map := old_capture->'payments_by_id';
  end if;
  -- Migrate the already persisted array representation into the keyed map in
  -- place so a webhook cannot discard sibling snapshots from older captures.
  if jsonb_typeof(old_capture->'payments') = 'array' then
    for payment_item in select value from jsonb_array_elements(old_capture->'payments') loop
      if nullif(payment_item->>'id', '') is not null then
        if not (payment_map ? (payment_item->>'id')) then
          payment_map := payment_map || jsonb_build_object(payment_item->>'id', payment_item);
        end if;
      end if;
    end loop;
  end if;

  -- A legacy sale date is replaceable only when the old payment snapshots
  -- explicitly identify that exact value as a pending payment forecast, and
  -- no prior effective-release proof was stored.
  if sale_row.data_liberacao is not null
     and (old_capture->'effective_release_at' is null or old_capture->'effective_release_at' = 'null'::jsonb) then
    for expected_id in select value from jsonb_array_elements_text(current_expected_ids) loop
      previous_payment := payment_map->expected_id;
      if previous_payment->>'money_release_status' is distinct from 'released'
         and nullif(previous_payment->>'money_release_date', '') is not null
         and (previous_payment->>'money_release_date') ~ '(Z|[+-][0-9]{2}:?[0-9]{2})$' then
        begin
          if (previous_payment->>'money_release_date')::timestamptz = sale_row.data_liberacao then
            previous_release_is_forecast := true;
            exit;
          end if;
        exception when others then
          -- Invalid stored dates do not prove that the sale date was a forecast.
          null;
        end;
      end if;
    end loop;
  end if;

  for payment_item in select value from jsonb_array_elements(p_payment_observations) loop
    if nullif(payment_item->>'id', '') is null
       or nullif(payment_item->>'status', '') is null
       or nullif(payment_item->>'observed_at', '') is null then
      raise exception 'Snapshot de pagamento incompleto';
    end if;
    payment_item := payment_item || jsonb_build_object('source_activity_id', p_activity_id);
    previous_payment := payment_map->(payment_item->>'id');
    incoming_version := nullif(payment_item->>'api_updated_at', '')::timestamptz;
    previous_version := nullif(previous_payment->>'api_updated_at', '')::timestamptz;
    if previous_payment is null
       or (incoming_version is not null and (previous_version is null or incoming_version > previous_version)) then
      payment_map := payment_map || jsonb_build_object(payment_item->>'id', payment_item);
    end if;
  end loop;

  for expected_id in select value from jsonb_array_elements_text(current_expected_ids) loop
    expected_count := expected_count + 1;
    previous_payment := payment_map->expected_id;
    if previous_payment is null
       or previous_payment->>'status' is distinct from 'approved'
       or nullif(previous_payment->>'commercial_net_cents', '') is null
       or coalesce(nullif(previous_payment->>'transaction_amount_refunded_cents', '')::numeric, 0) <> 0 then
      aggregate_complete := false;
      exit;
    end if;
    aggregate_cents := aggregate_cents + (previous_payment->>'commercial_net_cents')::numeric;
  end loop;
  if expected_count = 0 or not coalesce(p_allow_net_update, false) then aggregate_complete := false; end if;

  -- A sale-level release date is proven only after every expected payment is
  -- explicitly released and supplies a valid, offset-qualified timestamp.
  -- For multi-payment orders, the aggregate is fully released at the latest
  -- payment release instant. The sale-level historical date is not moved backward;
  -- an earlier proof is retained separately if the current set becomes incomplete.
  expected_count := 0;
  for expected_id in select value from jsonb_array_elements_text(current_expected_ids) loop
    expected_count := expected_count + 1;
    previous_payment := payment_map->expected_id;
    non_receiving_terminal := false;
    if previous_payment->>'status' in ('cancelled', 'rejected')
       and (case when coalesce(previous_payment->>'net_received_amount', '') ~ '^-?[0-9]+([.][0-9]{1,2})?$'
         then (previous_payment->>'net_received_amount')::numeric = 0 else false end)
       and (previous_payment->'transaction_amount_refunded' is null
         or previous_payment->'transaction_amount_refunded' = 'null'::jsonb
         or case when coalesce(previous_payment->>'transaction_amount_refunded', '') ~ '^-?[0-9]+([.][0-9]{1,2})?$'
           then (previous_payment->>'transaction_amount_refunded')::numeric = 0 else false end)
       and nullif(previous_payment->>'date_approved', '') is null
       and previous_payment->>'money_release_status' is distinct from 'released'
       and nullif(previous_payment->>'money_release_date', '') is null then
      non_receiving_terminal := true;
    end if;
    if non_receiving_terminal then
      continue;
    end if;
    relevant_count := relevant_count + 1;
    if previous_payment->>'status' in ('cancelled', 'rejected') then
      -- A terminal status with absent or contradictory receipt/approval data
      -- is not evidence that this attempt can be ignored or released.
      ambiguous_terminal_count := ambiguous_terminal_count + 1;
      continue;
    end if;
    if previous_payment->>'money_release_status' = 'released'
       and nullif(previous_payment->>'money_release_date', '') is not null
       and (previous_payment->>'money_release_date') ~ '(Z|[+-][0-9]{2}:?[0-9]{2})$' then
      begin
        current_effective_release_at := greatest(current_effective_release_at,
          (previous_payment->>'money_release_date')::timestamptz);
        release_count := release_count + 1;
      exception when others then null;
      end;
    end if;
  end loop;
  if expected_count = 0 or relevant_count = 0 or release_count <> relevant_count or ambiguous_terminal_count > 0 then current_effective_release_at := null; end if;
  if (old_capture->>'effective_release_at') ~ '(Z|[+-][0-9]{2}:?[0-9]{2})$' then
    begin
      previous_effective_release_at := (old_capture->>'effective_release_at')::timestamptz;
    exception when others then
      previous_effective_release_at := null;
    end;
  end if;
  if (old_capture->>'previous_effective_release_at') ~ '(Z|[+-][0-9]{2}:?[0-9]{2})$' then
    begin
      previous_effective_release_at := greatest(previous_effective_release_at,
        (old_capture->>'previous_effective_release_at')::timestamptz);
    exception when others then null;
    end;
  end if;
  approved_at := nullif(p_financial_capture->>'approved_at', '')::timestamptz;

  select coalesce(jsonb_agg(value order by key), '[]'::jsonb)
    into merged_capture
    from jsonb_each(payment_map);
  merged_capture := (old_capture || jsonb_strip_nulls(p_financial_capture - 'payments' - 'payments_by_id' - 'order_payment_ids' - 'order_api_updated_at'))
    || jsonb_build_object('payments_by_id', payment_map, 'payments', merged_capture);
  merged_capture := jsonb_set(merged_capture, '{order_payment_ids}', current_expected_ids, true);
  if incoming_order_version is not null and (previous_order_version is null or incoming_order_version > previous_order_version or stored_expected_ids is null) then
    merged_capture := jsonb_set(merged_capture, '{order_api_updated_at}', to_jsonb(incoming_order_version), true);
  elsif old_capture->'order_api_updated_at' is not null then
    merged_capture := jsonb_set(merged_capture, '{order_api_updated_at}', old_capture->'order_api_updated_at', true);
  end if;
  if current_effective_release_at is not null then
    merged_capture := jsonb_set(merged_capture, '{effective_release_at}', to_jsonb(current_effective_release_at), true);
    if previous_effective_release_at is not null then
      merged_capture := jsonb_set(merged_capture, '{previous_effective_release_at}', to_jsonb(previous_effective_release_at), true);
    end if;
  elsif previous_effective_release_at is not null then
    merged_capture := merged_capture - 'effective_release_at';
    merged_capture := jsonb_set(merged_capture, '{previous_effective_release_at}', to_jsonb(previous_effective_release_at), true);
  else
    merged_capture := merged_capture - 'effective_release_at' - 'previous_effective_release_at';
  end if;

  if aggregate_complete then
    merged_capture := jsonb_set(merged_capture, '{state}', '"complete"'::jsonb, true);
    merged_capture := jsonb_set(merged_capture, '{commercial_net}', to_jsonb(aggregate_cents / 100), true);
    merged_capture := merged_capture - 'previous_success';
  else
    merged_capture := jsonb_set(merged_capture, '{state}', '"partial"'::jsonb, true);
    if old_capture->'commercial_net' is not null and old_capture->'commercial_net' <> 'null'::jsonb then
      merged_capture := jsonb_set(merged_capture, '{commercial_net}', old_capture->'commercial_net', true);
      merged_capture := jsonb_set(merged_capture, '{previous_success}', coalesce(old_capture->'previous_success',
        jsonb_build_object('commercial_net', old_capture->'commercial_net', 'basis', old_capture->'basis', 'collected_at', old_capture->'collected_at')), true);
    end if;
  end if;

  update public.venda
     set raw_data = jsonb_set(coalesce(raw_data, '{}'::jsonb), '{financial_capture}', merged_capture, true),
         valor_liquido = case when aggregate_complete then (aggregate_cents / 100)::numeric(12,2) else valor_liquido end,
         data_pagamento = coalesce(data_pagamento, approved_at),
         data_liberacao = case
           when current_effective_release_at is not null and previous_release_is_forecast then current_effective_release_at
           when current_effective_release_at is not null then greatest(data_liberacao, current_effective_release_at)
           else data_liberacao
         end,
         updated_at = now()
   where id = sale_row.id
   returning data_liberacao into sale_row.data_liberacao;

  select count(*) into payment_count from jsonb_object_keys(payment_map);
  return jsonb_build_object('updated', true, 'sale_id', sale_row.id,
    'payment_count', payment_count, 'commercial_net_updated', aggregate_complete,
    'effective_release_at', current_effective_release_at,
    'previous_effective_release_at', previous_effective_release_at,
    'data_liberacao', sale_row.data_liberacao);
end;
$$;

revoke all on function public.persist_mercado_livre_payment_finance(uuid, text, text, jsonb, jsonb, jsonb, boolean, text)
  from public, anon, authenticated;
grant execute on function public.persist_mercado_livre_payment_finance(uuid, text, text, jsonb, jsonb, jsonb, boolean, text)
  to service_role;
