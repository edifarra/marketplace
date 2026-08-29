alter table public.products
  add column if not exists marketplace_update_pending boolean not null default false;

comment on column public.products.marketplace_update_pending is
  'Indica que os atributos do produto foram salvos com estoque zero e devem ser publicados quando o estoque voltar a ser positivo.';

-- Correcao pontual da duplicidade criada pela venda Shopee 260827FUDQP20F.
-- O anuncio 58264890592 ja estava ligado ao produto 1274PPS, mas o SKU que
-- veio no pedido (1274PP) criou um produto temporario antes da reconciliacao.
delete from public.venda_item
where venda_id = 'f1025408-13cb-4c19-9b9d-7d5f06b12163'
  and sku = '1274PP';

delete from public.estoque_movimentacao
where product_id = 'fbc99199-75bd-4fea-b147-73b9697eb1c8';

delete from public.estoque
where product_id = 'fbc99199-75bd-4fea-b147-73b9697eb1c8';

delete from public.products
where id = 'fbc99199-75bd-4fea-b147-73b9697eb1c8'
  and sku = '1274PP'
  and source_key = 'marketplace_shopee_1274PP';
