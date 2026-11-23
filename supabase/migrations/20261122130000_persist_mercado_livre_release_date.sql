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
  payment_count integer := 0;
  expected_count integer := 0;
  release_count integer := 0;
  aggregate_cents numeric := 0;
  aggregate_complete boolean := true;
  approved_at timestamptz;
  effective_release_at timestamptz;
  previous_effective_release_at timestamptz;
  previous_release_is_forecast boolean := false;
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
    for expected_id in select value from jsonb_array_elements_text(p_expected_payment_ids) loop
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

  for expected_id in select value from jsonb_array_elements_text(p_expected_payment_ids) loop
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
  -- payment release instant. Existing proven values are never moved backward.
  expected_count := 0;
  for expected_id in select value from jsonb_array_elements_text(p_expected_payment_ids) loop
    expected_count := expected_count + 1;
    previous_payment := payment_map->expected_id;
    if previous_payment->>'money_release_status' = 'released'
       and nullif(previous_payment->>'money_release_date', '') is not null
       and (previous_payment->>'money_release_date') ~ '(Z|[+-][0-9]{2}:?[0-9]{2})$' then
      begin
        effective_release_at := greatest(effective_release_at,
          (previous_payment->>'money_release_date')::timestamptz);
        release_count := release_count + 1;
      exception when others then
        -- An invalid timestamp is not evidence of an effective release date.
        release_count := 0;
        effective_release_at := null;
      end;
    else
      release_count := 0;
      effective_release_at := null;
    end if;
  end loop;
  if expected_count = 0 or release_count <> expected_count then effective_release_at := null; end if;
  if (old_capture->>'effective_release_at') ~ '(Z|[+-][0-9]{2}:?[0-9]{2})$' then
    begin
      previous_effective_release_at := (old_capture->>'effective_release_at')::timestamptz;
    exception when others then
      previous_effective_release_at := null;
    end;
  end if;
  effective_release_at := greatest(effective_release_at, previous_effective_release_at);

  approved_at := nullif(p_financial_capture->>'approved_at', '')::timestamptz;

  select coalesce(jsonb_agg(value order by key), '[]'::jsonb)
    into merged_capture
    from jsonb_each(payment_map);
  merged_capture := (old_capture || jsonb_strip_nulls(p_financial_capture - 'payments' - 'payments_by_id'))
    || jsonb_build_object('payments_by_id', payment_map, 'payments', merged_capture);
  if effective_release_at is not null then
    merged_capture := jsonb_set(merged_capture, '{effective_release_at}', to_jsonb(effective_release_at), true);
  elsif old_capture->'effective_release_at' is not null and old_capture->'effective_release_at' <> 'null'::jsonb then
    merged_capture := jsonb_set(merged_capture, '{effective_release_at}', old_capture->'effective_release_at', true);
  else
    merged_capture := merged_capture - 'effective_release_at';
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
           when effective_release_at is not null and previous_release_is_forecast then effective_release_at
           when effective_release_at is not null then greatest(data_liberacao, effective_release_at)
           else data_liberacao
         end,
         updated_at = now()
   where id = sale_row.id;

  select count(*) into payment_count from jsonb_object_keys(payment_map);
  return jsonb_build_object('updated', true, 'sale_id', sale_row.id,
    'payment_count', payment_count, 'commercial_net_updated', aggregate_complete,
    'effective_release_at', case
      when previous_release_is_forecast then effective_release_at
      else coalesce(greatest(sale_row.data_liberacao, effective_release_at), sale_row.data_liberacao, effective_release_at)
    end);
end;
$$;

revoke all on function public.persist_mercado_livre_payment_finance(uuid, text, text, jsonb, jsonb, jsonb, boolean, text)
  from public, anon, authenticated;
grant execute on function public.persist_mercado_livre_payment_finance(uuid, text, text, jsonb, jsonb, jsonb, boolean, text)
  to service_role;
