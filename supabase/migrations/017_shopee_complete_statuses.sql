-- Status oficiais de pedido e de logística da Shopee Open Platform v2.
-- As combinações permitem traduzir também o logistics_status de cada pacote.

with order_status(external_status, internal_status, description, reserves_stock, final_status) as (values
  ('UNPAID', 'aguardando_pagamento', 'Pagamento pendente', false, false),
  ('READY_TO_SHIP', 'pronta_para_envio', 'Pronta para envio', true, false),
  ('PROCESSED', 'pronta_para_envio', 'Envio organizado e pronto para etiqueta', true, false),
  ('RETRY_SHIP', 'pronta_para_envio', 'Nova tentativa de organizar o envio', true, false),
  ('SHIPPED', 'a_caminho', 'Pedido enviado', false, false),
  ('TO_CONFIRM_RECEIVE', 'a_caminho', 'Aguardando confirmação de recebimento', false, false),
  ('IN_CANCEL', 'cancelamento_solicitado', 'Cancelamento solicitado', false, false),
  ('CANCELLED', 'cancelada', 'Pedido cancelado', false, true),
  ('TO_RETURN', 'devolucao_solicitada', 'Devolução ou reembolso solicitado', false, false),
  ('COMPLETED', 'concluida', 'Pedido concluído', false, true)
)
insert into status_venda(marketplace, external_status, internal_status, description, reserves_stock, final_status)
select 'shopee', external_status, internal_status, description, reserves_stock, final_status from order_status
on conflict (marketplace, external_status) do update set
  internal_status=excluded.internal_status, description=excluded.description,
  reserves_stock=excluded.reserves_stock, final_status=excluded.final_status;

with logistics_status(external_status, internal_status, description, final_status) as (values
  ('LOGISTICS_NOT_START', 'pronta_para_envio', 'Logística ainda não iniciada', false),
  ('LOGISTICS_READY', 'pronta_para_envio', 'Pacote pronto para envio', false),
  ('LOGISTICS_REQUEST_CREATED', 'pronta_para_envio', 'Solicitação de coleta criada', false),
  ('LOGISTICS_PICKUP_PENDING', 'pronta_para_envio', 'Coleta pendente', false),
  ('LOGISTICS_PICKUP_RETRY', 'pronta_para_envio', 'Nova tentativa de coleta', false),
  ('LOGISTICS_PICKUP_DONE', 'a_caminho', 'Pacote coletado', false),
  ('LOGISTICS_PICKUP_FAILED', 'pronta_para_envio', 'Falha na coleta', false),
  ('LOGISTICS_PARCEL_RECEIVED', 'a_caminho', 'Pacote recebido pela transportadora', false),
  ('LOGISTICS_TRANSPORTING', 'a_caminho', 'Pacote em trânsito', false),
  ('LOGISTICS_DELIVERING', 'saiu_para_entrega', 'Pacote saiu para entrega', false),
  ('LOGISTICS_DELIVERY_DONE', 'entregue', 'Pacote entregue', true),
  ('LOGISTICS_DELIVERY_FAILED', 'a_caminho', 'Tentativa de entrega não concluída', false),
  ('LOGISTICS_REQUEST_CANCELED', 'cancelada', 'Envio cancelado', true),
  ('LOGISTICS_COD_REJECTED', 'cancelada', 'Pagamento na entrega recusado', true),
  ('LOGISTICS_LOST', 'cancelada', 'Pacote extraviado', true),
  ('LOGISTICS_INVALID', 'cancelada', 'Envio inválido', true),
  ('LOGISTICS_UNKNOWN', 'a_caminho', 'Situação logística desconhecida', false)
), order_status(external_status) as (values
  ('UNPAID'),('READY_TO_SHIP'),('PROCESSED'),('RETRY_SHIP'),('SHIPPED'),
  ('TO_CONFIRM_RECEIVE'),('IN_CANCEL'),('CANCELLED'),('TO_RETURN'),('COMPLETED')
), mappings as (
  select l.external_status, l.internal_status, l.description, false as reserves_stock, l.final_status
  from logistics_status l
  union all
  select o.external_status || '::' || l.external_status,
         l.internal_status, l.description, o.external_status in ('READY_TO_SHIP','PROCESSED','RETRY_SHIP'), l.final_status
  from order_status o cross join logistics_status l
)
insert into status_venda(marketplace, external_status, internal_status, description, reserves_stock, final_status)
select 'shopee', external_status, internal_status, description, reserves_stock, final_status from mappings
on conflict (marketplace, external_status) do update set
  internal_status=excluded.internal_status, description=excluded.description,
  reserves_stock=excluded.reserves_stock, final_status=excluded.final_status;
