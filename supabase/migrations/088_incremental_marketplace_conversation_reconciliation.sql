-- Distribui a reconciliação remota entre interações pendentes sem varrer todo
-- o histórico a cada ciclo do worker.
alter table marketplace_conversations
  add column if not exists last_reconciled_at timestamptz;

create index if not exists idx_marketplace_conversations_reconciliation
  on marketplace_conversations(marketplace, marketplace_account_id, conversation_type, last_reconciled_at nulls first, last_message_at desc)
  where requires_response = true;
