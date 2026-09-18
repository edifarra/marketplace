-- Evita que um UPDATE idêntico de mensagem produza um falso delta na tela.
create or replace function touch_marketplace_conversation_from_message()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and new is not distinct from old then
    return new;
  end if;

  update marketplace_conversations
  set updated_at = clock_timestamp()
  where id = case when tg_op = 'DELETE' then old.conversation_id else new.conversation_id end;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
