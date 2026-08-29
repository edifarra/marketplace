-- Desempata mensagens criadas no mesmo segundo pelo ID sequencial da Shopee.
with latest as (
  select distinct on (message.conversation_id)
    message.conversation_id,
    message.direction,
    message.sent_at
  from marketplace_conversation_messages message
  join marketplace_conversations conversation on conversation.id = message.conversation_id
  where conversation.marketplace = 'shopee'
  order by message.conversation_id, message.sent_at desc,
    case when message.raw_data ->> 'message_id' ~ '^[0-9]+$' then (message.raw_data ->> 'message_id')::numeric else 0 end desc,
    message.created_at desc
)
update marketplace_conversations conversation
set
  requires_response = latest.direction = 'incoming',
  unread = latest.direction = 'incoming',
  status = case when latest.direction = 'incoming' then 'pending' else 'answered' end,
  last_message_at = latest.sent_at,
  updated_at = now()
from latest
where conversation.id = latest.conversation_id;
