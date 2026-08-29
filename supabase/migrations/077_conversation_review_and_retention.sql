-- Registra a revisão manual dos históricos para que uma nova sincronização
-- não reabra conversas antigas sem que exista mensagem posterior à revisão.
alter table marketplace_conversations
  add column if not exists reviewed_at timestamptz;

update marketplace_conversations
set
  status = 'answered',
  requires_response = false,
  unread = false,
  reviewed_at = now(),
  updated_at = now()
where last_message_at < (
  date_trunc('day', now() at time zone 'America/Sao_Paulo')
  at time zone 'America/Sao_Paulo'
);

create index if not exists idx_marketplace_conversations_created_at
  on marketplace_conversations(created_at);
