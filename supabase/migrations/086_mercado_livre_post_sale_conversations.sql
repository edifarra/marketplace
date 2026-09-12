alter table marketplace_conversations
  add column if not exists pack_id text,
  add column if not exists seller_id text,
  add column if not exists conversation_path text,
  add column if not exists counterparty_id text,
  add column if not exists messaging_agent boolean not null default false;

alter table marketplace_conversation_messages
  add column if not exists marketplace_account_id uuid references config_marketplace_accounts(id) on delete cascade,
  add column if not exists external_message_key text;

update marketplace_conversation_messages message
set marketplace_account_id = conversation.marketplace_account_id
from marketplace_conversations conversation
where conversation.id = message.conversation_id
  and message.marketplace_account_id is null;

with ranked as (
  select message.id, message.conversation_id, conversation.marketplace, conversation.conversation_type,
    row_number() over (
      partition by conversation.marketplace_account_id, message.external_message_id
      order by message.created_at, message.id
    ) as occurrence
  from marketplace_conversation_messages message
  join marketplace_conversations conversation on conversation.id = message.conversation_id
)
update marketplace_conversation_messages message
set external_message_key = case
  when ranked.marketplace = 'mercado_livre' and ranked.conversation_type = 'post_sale' and ranked.occurrence = 1
    then 'ml-message:' || message.external_message_id
  when ranked.marketplace = 'mercado_livre' and ranked.conversation_type = 'post_sale'
    then null
  else ranked.marketplace || ':' || ranked.conversation_type || ':' || ranked.conversation_id || ':' || message.external_message_id
end
from ranked
where ranked.id = message.id and message.external_message_key is null;

create unique index if not exists uq_marketplace_message_per_account
  on marketplace_conversation_messages(marketplace_account_id, external_message_key)
  where marketplace_account_id is not null and external_message_key is not null;

create index if not exists idx_marketplace_conversations_pack
  on marketplace_conversations(marketplace, marketplace_account_id, pack_id, order_id);
