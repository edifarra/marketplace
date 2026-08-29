do $$
declare
  ml_gi_count integer;
  sp_ed_count integer;
  sp_gi_count integer;
  unlinked_count integer;
begin
  select count(*) into ml_gi_count
  from public.product_marketplace_variations v
  join public.config_marketplace_accounts a on a.id = v.marketplace_account_id
  where a.name = 'ML-GI';

  select count(*) into sp_ed_count
  from public.product_marketplace_variations v
  join public.config_marketplace_accounts a on a.id = v.marketplace_account_id
  where a.name = 'SP-ED';

  select count(*) into sp_gi_count
  from public.product_marketplace_variations v
  join public.config_marketplace_accounts a on a.id = v.marketplace_account_id
  where a.name = 'SP-GI';

  select count(*) into unlinked_count
  from public.product_marketplace_variations v
  join public.config_marketplace_accounts a on a.id = v.marketplace_account_id
  where a.name in ('ML-GI', 'SP-ED', 'SP-GI') and v.product_id is null;

  if ml_gi_count <> 36 or sp_ed_count <> 50 or sp_gi_count <> 7 or unlinked_count <> 0 then
    raise exception 'Falha na validacao de variacoes: ML-GI %, SP-ED %, SP-GI %, sem produto %',
      ml_gi_count, sp_ed_count, sp_gi_count, unlinked_count;
  end if;
end $$;
