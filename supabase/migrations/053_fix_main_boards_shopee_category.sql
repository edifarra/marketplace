-- A categoria real dos anuncios de placas main na Shopee e Outros (100189),
-- nao TVs (100185).
update public.marketplace_category_mappings
set shopee_code = '100189',
    shopee_description = 'Eletrodomésticos > TVs e Acessórios > Outros',
    attribute_definitions = attribute_definitions - 'shopee',
    updated_at = now()
where internal_category = 'Pecas para TV > Placas Main';

-- Corrige o snapshot legado deste produto sem alterar os IDs efetivos dos
-- marketplaces, que ja correspondem aos anuncios atuais.
update public.products
set marketplace_attribute_schema_version = 1
where upper(sku) = '1090PP.110226';

update public.products
set marketplace_categories = jsonb_set(
      marketplace_categories,
      '{internal_category}',
      to_jsonb('Pecas para TV > Placas Main'::text),
      true
    ),
    marketplace_attribute_schema_version = 2,
    updated_at = now()
where upper(sku) = '1090PP.110226';
