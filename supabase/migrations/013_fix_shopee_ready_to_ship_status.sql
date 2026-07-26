-- READY_TO_SHIP nao significa apenas pagamento confirmado: o pedido ja esta
-- liberado para preparacao e postagem.
update status_venda
set internal_status = 'pronta_para_envio',
    description = 'Pronta para envio',
    reserves_stock = false,
    final_status = false
where marketplace = 'shopee'
  and external_status = 'READY_TO_SHIP';
