-- Algumas conversas não retornam histórico no get_message; nesses casos, usa-se
-- o timestamp em nanossegundos presente na própria lista de conversas.
update marketplace_conversations conversation
set
  last_message_at = to_timestamp((conversation.raw_data ->> 'last_message_timestamp')::numeric / 1000000000),
  last_incoming_at = case
    when conversation.requires_response then to_timestamp((conversation.raw_data ->> 'last_message_timestamp')::numeric / 1000000000)
    else null
  end,
  last_outgoing_at = case
    when conversation.requires_response then null
    else to_timestamp((conversation.raw_data ->> 'last_message_timestamp')::numeric / 1000000000)
  end,
  updated_at = now()
where conversation.marketplace = 'shopee'
  and conversation.raw_data ? 'last_message_timestamp'
  and (conversation.raw_data ->> 'last_message_timestamp') ~ '^[0-9]+$'
  and not exists (
    select 1 from marketplace_conversation_messages message
    where message.conversation_id = conversation.id
  );
