-- O SKU canonico deste produto e 1274PP. O sufixo S permaneceu em registros
-- importados antigos da Shopee e nao deve ser usado como identidade interna.
update public.products
set sku = '1274PP',
    source_key = case
      when source_key = 'marketplace_shopee_1274PPS' then 'marketplace_shopee_1274PP'
      else source_key
    end,
    updated_at = now()
where id = '0407565e-4f7b-4874-96b9-d93097212f4d'
  and sku = '1274PPS';

update public.estoque
set sku = '1274PP', updated_at = now()
where product_id = '0407565e-4f7b-4874-96b9-d93097212f4d';

update public.product_marketplaces
set sku = '1274PP', updated_at = now()
where product_id = '0407565e-4f7b-4874-96b9-d93097212f4d';

update public.listings
set external_sku = '1274PP'
where product_id = '0407565e-4f7b-4874-96b9-d93097212f4d';

update public.product_marketplace_variations
set sku = '1274PP', updated_at = now()
where product_id = '0407565e-4f7b-4874-96b9-d93097212f4d';

update public.venda_item
set sku = '1274PP'
where venda_id = 'f1025408-13cb-4c19-9b9d-7d5f06b12163'
  and sku = '1274PPS';

update public.estoque_movimentacao
set sku = '1274PP'
where product_id = '0407565e-4f7b-4874-96b9-d93097212f4d';
