-- Consolida o draft local com a mensagem definitiva sem remover a constraint
-- unica. Webhook e processo de envio podem chegar em qualquer ordem.
create or replace function finalize_marketplace_conversation_reply(
  p_conversation_id uuid,
  p_draft_id text,
  p_external_message_id text,
  p_text text,
  p_sent_at timestamptz,
  p_raw_data jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_canonical_id uuid;
  v_draft_id uuid;
  v_reconciled boolean := false;
begin
  if coalesce(p_external_message_id, '') = '' then
    raise exception 'O identificador definitivo da mensagem nao foi informado.';
  end if;

  select id into v_canonical_id
  from marketplace_conversation_messages
  where conversation_id = p_conversation_id
    and external_message_id = p_external_message_id
  for update;

  select id into v_draft_id
  from marketplace_conversation_messages
  where conversation_id = p_conversation_id
    and external_message_id = p_draft_id
  for update;

  if v_canonical_id is not null then
    if v_draft_id is not null and v_draft_id <> v_canonical_id then
      delete from marketplace_conversation_messages where id = v_draft_id;
    end if;
    v_reconciled := true;
  elsif v_draft_id is not null then
    begin
      update marketplace_conversation_messages
      set external_message_id = p_external_message_id,
          text = p_text,
          sent_at = p_sent_at,
          status = 'sent',
          raw_data = coalesce(p_raw_data, '{}'::jsonb)
      where id = v_draft_id;
    exception when unique_violation then
      -- Outro fluxo inseriu a mensagem definitiva depois das leituras acima.
      delete from marketplace_conversation_messages where id = v_draft_id;
      v_reconciled := true;
    end;
  else
    begin
      insert into marketplace_conversation_messages (
        conversation_id, external_message_id, direction, message_type, text,
        sent_at, status, raw_data
      ) values (
        p_conversation_id, p_external_message_id, 'outgoing', 'text', p_text,
        p_sent_at, 'sent', coalesce(p_raw_data, '{}'::jsonb)
      );
    exception when unique_violation then
      v_reconciled := true;
    end;
  end if;

  update marketplace_conversations
  set status = 'answered',
      requires_response = false,
      unread = false,
      last_outgoing_at = p_sent_at,
      last_message_at = greatest(last_message_at, p_sent_at),
      last_message_preview = left(coalesce(p_text, ''), 240),
      last_error = null,
      updated_at = now()
  where id = p_conversation_id;

  return jsonb_build_object('reconciled', v_reconciled);
end;
$$;

revoke all on function finalize_marketplace_conversation_reply(uuid, text, text, text, timestamptz, jsonb) from public;
grant execute on function finalize_marketplace_conversation_reply(uuid, text, text, text, timestamptz, jsonb) to service_role;
