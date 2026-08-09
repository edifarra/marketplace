-- Regrava as descrições Shopee em UTF-8 e corrige instalações que receberam
-- caracteres de substituição durante uma carga externa.

update status_venda
set description = case
  when external_status = 'COMPLETED' then 'Pedido concluído'
  when external_status = 'TO_CONFIRM_RECEIVE' then 'Aguardando confirmação de recebimento'
  when external_status = 'TO_RETURN' then 'Devolução ou reembolso solicitado'
  when external_status = 'LOGISTICS_NOT_START' or external_status like '%::LOGISTICS_NOT_START' then 'Logística ainda não iniciada'
  when external_status = 'LOGISTICS_REQUEST_CREATED' or external_status like '%::LOGISTICS_REQUEST_CREATED' then 'Solicitação de coleta criada'
  when external_status = 'LOGISTICS_TRANSPORTING' or external_status like '%::LOGISTICS_TRANSPORTING' then 'Pacote em trânsito'
  when external_status = 'LOGISTICS_DELIVERY_FAILED' or external_status like '%::LOGISTICS_DELIVERY_FAILED' then 'Tentativa de entrega não concluída'
  when external_status = 'LOGISTICS_INVALID' or external_status like '%::LOGISTICS_INVALID' then 'Envio inválido'
  when external_status = 'LOGISTICS_UNKNOWN' or external_status like '%::LOGISTICS_UNKNOWN' then 'Situação logística desconhecida'
  else description
end
where marketplace = 'shopee';
