-- Mantém a conversa como cursor canônico de qualquer mudança em suas mensagens.
create or replace function touch_marketplace_conversation_from_message()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  update marketplace_conversations
  set updated_at = clock_timestamp()
  where id = case when tg_op = 'DELETE' then old.conversation_id else new.conversation_id end;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists trg_touch_marketplace_conversation_from_message
  on marketplace_conversation_messages;
create trigger trg_touch_marketplace_conversation_from_message
after insert or update or delete on marketplace_conversation_messages
for each row execute function touch_marketplace_conversation_from_message();

create index if not exists idx_marketplace_conversations_updated_cursor
  on marketplace_conversations(updated_at, id);
