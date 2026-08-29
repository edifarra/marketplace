-- Corrige classificações iniciais com base nos indicadores originais das APIs.
update marketplace_conversations
set status = 'closed', requires_response = false, unread = false,
    external_status = concat(coalesce(external_status, 'UNANSWERED'), ' / REMOVED_FROM_LISTING'),
    updated_at = now()
where marketplace = 'mercado_livre'
  and coalesce((raw_data->>'deleted_from_listing')::boolean, false) = true;

update marketplace_conversations
set external_status = 'NOT_INFORMED', updated_at = now()
where marketplace = 'shopee'
  and external_status = 'active'
  and not (raw_data ? 'status');

