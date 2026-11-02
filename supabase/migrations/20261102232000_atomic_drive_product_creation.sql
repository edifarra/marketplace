-- Prepared locally only. Apply after authorization, before deploying the application.
-- Invoker privileges and an explicit service_role grant keep this out of browser APIs.
create or replace function public.create_drive_product_atomically(
  p_product jsonb, p_images jsonb, p_accounts jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  product_record products%rowtype;
  existing_product products%rowtype;
  created_id uuid;
  image jsonb;
  account jsonb;
  image_count integer;
  source_hash text;
begin
  if jsonb_typeof(p_product) is distinct from 'object'
     or nullif(p_product->>'source_key', '') is null then
    raise exception 'Produto Drive invalido';
  end if;
  -- Serialize retries/concurrent loaders for the same source, without changing existing products.
  perform pg_advisory_xact_lock(hashtextextended(p_product->>'source_key', 0));
  select * into existing_product from products where source_key = p_product->>'source_key';
  if found then
    return jsonb_build_object('id', existing_product.id, 'sku', existing_product.sku, 'created', false);
  end if;

  if jsonb_typeof(p_images) is distinct from 'array' or jsonb_typeof(p_accounts) is distinct from 'array' then
    raise exception 'Fotografias ou contas invalidas';
  end if;
  image_count := jsonb_array_length(p_images);
  if image_count not between 1 and 6 or jsonb_array_length(p_accounts) < 1 then
    raise exception 'Fotografias ou contas ausentes';
  end if;
  source_hash := encode(sha256(convert_to(p_product->>'source_key', 'UTF8')), 'hex');
  for image in select value from jsonb_array_elements(p_images) with ordinality as entries(value, n)
  loop
    if (image->>'position')::integer is null
       or (image->>'position')::integer not between 1 and image_count
       or (image->>'bytes')::bigint is null or (image->>'bytes')::bigint <= 0
       or (image->>'width_px')::integer is null or (image->>'width_px')::integer not between 1 and 1200
       or (image->>'height_px')::integer is null or (image->>'height_px')::integer not between 1 and 1200
       or nullif(image->>'drive_file_id', '') is null or nullif(image->>'original_name', '') is null
       or (image->>'local_path') is null
       or (image->>'local_path') !~ ('^produtos/' || left(source_hash, 2) || '/' || source_hash || '/' || (image->>'position') || '-[a-f0-9]{64}\.jpg$')
       or (image->>'url') is distinct from ('https://api.gestaomarketplace.tech/Imagens/' || (image->>'local_path'))
       or (image->>'local_url') is distinct from (image->>'url') then
      raise exception 'Metadados da fotografia VPS invalidos';
    end if;
  end loop;
  if (select count(distinct (value->>'position')::integer) from jsonb_array_elements(p_images)) <> image_count then
    raise exception 'Posicoes duplicadas';
  end if;

  product_record := jsonb_populate_record(null::products, p_product);
  insert into products (
    sku, source_key, type_code, brand_code, special_code, model, version, board_code, title,
    price, stock, status, marketplace_categories, marketplace_attributes, marketplace_attribute_schema_version,
    width, height, length, weight_net, weight_gross
  ) values (
    product_record.sku, product_record.source_key, product_record.type_code, product_record.brand_code,
    product_record.special_code, product_record.model, product_record.version, product_record.board_code,
    product_record.title, 0, product_record.stock, 'pending_price', product_record.marketplace_categories,
    product_record.marketplace_attributes, product_record.marketplace_attribute_schema_version,
    product_record.width, product_record.height, product_record.length, product_record.weight_net, product_record.weight_gross
  ) returning id into created_id;

  insert into product_images (
    product_id, drive_file_id, original_name, url, local_url, local_path,
    bytes, width_px, height_px, position, status
  ) select created_id, value->>'drive_file_id', value->>'original_name', value->>'url', value->>'local_url',
    value->>'local_path', (value->>'bytes')::bigint, (value->>'width_px')::integer,
    (value->>'height_px')::integer, (value->>'position')::integer, 'uploaded'
    from jsonb_array_elements(p_images);

  for account in select value from jsonb_array_elements(p_accounts)
  loop
    insert into listings (
      product_id, marketplace, marketplace_account_id, marketplace_name, external_sku, status, stock, price
    ) values (
      created_id, (account->>'marketplace')::marketplace_code, nullif(account->>'id', '')::uuid,
      account->>'name', product_record.sku, 'draft', product_record.stock, 0
    );
  end loop;
  return jsonb_build_object('id', created_id, 'sku', product_record.sku, 'created', true);
end;
$$;

revoke all on function public.create_drive_product_atomically(jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.create_drive_product_atomically(jsonb, jsonb, jsonb) to service_role;
