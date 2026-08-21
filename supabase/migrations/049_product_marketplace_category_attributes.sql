alter table marketplace_category_mappings
  add column if not exists attribute_definitions jsonb not null default '{}'::jsonb;

alter table config_types
  add column if not exists marketplace_attribute_defaults jsonb not null default '{}'::jsonb;

alter table products
  add column if not exists marketplace_categories jsonb not null default '{}'::jsonb,
  add column if not exists marketplace_attributes jsonb not null default '{}'::jsonb,
  add column if not exists marketplace_attribute_schema_version integer not null default 1;

comment on column marketplace_category_mappings.attribute_definitions is
  'Catalogo de atributos e opcoes retornados pelos marketplaces para cada categoria.';
comment on column config_types.marketplace_attribute_defaults is
  'Valores iniciais de atributos copiados para novos produtos deste tipo.';
comment on column products.marketplace_categories is
  'Snapshot imutavel das categorias por marketplace. So pode mudar sem vinculos externos.';
comment on column products.marketplace_attributes is
  'Valores definitivos dos atributos por marketplace, exclusivos do produto.';

create or replace function prevent_linked_product_category_change()
returns trigger
language plpgsql
as $$
begin
  if new.marketplace_categories is distinct from old.marketplace_categories
     and (
       exists (
         select 1 from product_marketplaces pm
         where pm.product_id = old.id
           and coalesce(pm.existe_no_marketplace, true) = true
           and nullif(pm.marketplace_product_id, '') is not null
       )
       or exists (
         select 1 from listings l
         where l.product_id = old.id
           and nullif(l.external_listing_id, '') is not null
       )
       or nullif(old.tiny_product_id, '') is not null
     ) then
    raise exception 'A categoria do produto nao pode ser alterada enquanto existirem vinculos com marketplaces.';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_prevent_linked_product_category_change on products;
create trigger trg_prevent_linked_product_category_change
before update of marketplace_categories on products
for each row execute function prevent_linked_product_category_change();
