-- Mantem contexto util de auditoria sem armazenar credenciais HTTP.

update deletion_audit_logs
set request_context = request_context - 'headers'
where request_context ? 'headers';

create or replace function audit_deleted_record()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  old_data jsonb := to_jsonb(old);
  resolved_product_id uuid;
  resolved_sku text;
  jwt_claims jsonb := '{}';
  request_headers jsonb := '{}';
begin
  begin
    jwt_claims := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}');
  exception when others then jwt_claims := '{}';
  end;
  begin
    request_headers := coalesce(nullif(current_setting('request.headers', true), '')::jsonb, '{}');
  exception when others then request_headers := '{}';
  end;
  begin
    resolved_product_id := nullif(old_data ->> 'product_id', '')::uuid;
  exception when invalid_text_representation then resolved_product_id := null;
  end;
  if tg_table_name = 'products' then resolved_product_id := nullif(old_data ->> 'id', '')::uuid; end if;
  resolved_sku := nullif(btrim(coalesce(old_data ->> 'sku', old_data ->> 'external_sku', old_data ->> 'seller_sku')), '');
  if resolved_sku is null and resolved_product_id is not null and tg_table_name <> 'products' then
    select p.sku into resolved_sku from products p where p.id = resolved_product_id;
  end if;

  insert into deletion_audit_logs(table_name,record_id,product_id,sku,marketplace,listing_id,tiny_product_id,
    record_data,request_context,database_role,client_address,transaction_id)
  values(tg_table_name,old_data ->> 'id',resolved_product_id,resolved_sku,nullif(old_data ->> 'marketplace',''),
    nullif(coalesce(old_data ->> 'marketplace_product_id',old_data ->> 'external_listing_id',old_data ->> 'listing_id'),''),
    nullif(old_data ->> 'tiny_product_id',''),old_data,
    jsonb_build_object(
      'actor_id', jwt_claims ->> 'sub',
      'actor_role', jwt_claims ->> 'role',
      'user_agent', request_headers ->> 'user-agent',
      'client_info', request_headers ->> 'x-client-info',
      'forwarded_for', request_headers ->> 'x-forwarded-for',
      'application_name', current_setting('application_name', true)
    ),current_user,inet_client_addr(),txid_current());
  return old;
end;
$$;
