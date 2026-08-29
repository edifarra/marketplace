-- Corrige conversas históricas da Shopee que foram gravadas com a hora da sincronização.
-- A API informa last_message_timestamp em nanossegundos.
with corrected as (
  select
    id,
    to_timestamp((raw_data ->> 'last_message_timestamp')::numeric / 1000000000) as message_at,
    coalesce((raw_data ->> 'unread_count')::integer, 0) as unread_count
  from marketplace_conversations
  where marketplace = 'shopee'
    and raw_data ? 'last_message_timestamp'
    and (raw_data ->> 'last_message_timestamp') ~ '^[0-9]+$'
)
update marketplace_conversations conversation
set
  last_message_at = corrected.message_at,
  last_incoming_at = case when conversation.requires_response then corrected.message_at else conversation.last_incoming_at end,
  requires_response = case when corrected.unread_count > 0 then conversation.requires_response else false end,
  unread = corrected.unread_count > 0,
  status = case
    when corrected.unread_count = 0 and conversation.status = 'pending' then 'answered'
    else conversation.status
  end,
  updated_at = now()
from corrected
where conversation.id = corrected.id;
