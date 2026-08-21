-- A arvore da Shopee nao marca este atributo como obrigatorio e anuncios ativos
-- da categoria 100189 existem sem ele. Remove a regra sintetica incorreta.
update public.marketplace_category_mappings
set attribute_definitions = attribute_definitions #- '{shopee,attributes,102385}',
    updated_at = now()
where shopee_code = '100189'
  and attribute_definitions #> '{shopee,attributes,102385}' is not null;
