-- Central unificada de perguntas e chats dos marketplaces.

create table if not exists marketplace_conversations (
  id uuid primary key default gen_random_uuid(),
  marketplace text not null check (marketplace in ('mercado_livre','shopee')),
  marketplace_account_id uuid not null references config_marketplace_accounts(id) on delete cascade,
  external_conversation_id text not null,
  conversation_type text not null check (conversation_type in ('question','chat','post_sale')),
  external_status text,
  status text not null default 'pending' check (status in ('pending','answered','closed','review','blocked','error')),
  requires_response boolean not null default true,
  unread boolean not null default true,
  buyer_id text,
  buyer_name text,
  product_id uuid references products(id) on delete set null,
  listing_id text,
  order_id text,
  sku text,
  product_title text,
  product_price numeric(12,2),
  available_stock integer,
  product_status text,
  purchased_at timestamptz,
  last_incoming_at timestamptz,
  last_outgoing_at timestamptz,
  last_message_at timestamptz not null default now(),
  last_message_preview text,
  last_error text,
  raw_data jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (marketplace, marketplace_account_id, external_conversation_id)
);

create index if not exists idx_marketplace_conversations_pending
  on marketplace_conversations(requires_response, last_incoming_at, last_message_at)
  where requires_response = true;
create index if not exists idx_marketplace_conversations_filters
  on marketplace_conversations(marketplace, marketplace_account_id, status, last_message_at desc);
create index if not exists idx_marketplace_conversations_product
  on marketplace_conversations(product_id, listing_id, order_id);

create table if not exists marketplace_conversation_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references marketplace_conversations(id) on delete cascade,
  external_message_id text not null,
  direction text not null check (direction in ('incoming','outgoing','system')),
  message_type text not null default 'text',
  text text,
  sender_id text,
  sender_name text,
  sent_at timestamptz not null,
  status text not null default 'received' check (status in ('received','queued','sent','error','blocked')),
  automatic boolean not null default false,
  raw_data jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (conversation_id, external_message_id)
);

create index if not exists idx_marketplace_conversation_messages_timeline
  on marketplace_conversation_messages(conversation_id, sent_at, created_at);

alter table outgoing_marketplace_activities drop constraint if exists outgoing_marketplace_activities_activity_type_check;
alter table outgoing_marketplace_activities add constraint outgoing_marketplace_activities_activity_type_check
  check (activity_type in ('stock_update','listing_create','listing_update','listing_delete','answer_send','question_answer'));

insert into settings(key,value,description) values
  ('CHAT_SLA_WITH_PRODUCT_HOURS', '1'::jsonb, '[CONFIG_GERAL] SLA de Chats com Produtos Vinculados (horas).'),
  ('CHAT_SLA_WITHOUT_PRODUCT_HOURS', '6'::jsonb, '[CONFIG_GERAL] SLA de Chats sem Produtos Vinculados (horas).')
on conflict (key) do nothing;

create or replace function requeue_outgoing_marketplace_activity(p_id uuid, p_error text)
returns void language plpgsql security definer set search_path = public as $$
declare v_attempts integer; v_activity_type text;
begin
  select attempt_count, activity_type into v_attempts, v_activity_type
  from outgoing_marketplace_activities where id = p_id for update;
  update outgoing_marketplace_activities set
    status = case when v_attempts >= 5 then 'error' else 'retry' end,
    processing_error = p_error,
    processed_at = case when v_attempts >= 5 then now() else null end,
    next_attempt_at = case
      when v_attempts >= 5 then now()
      when v_activity_type in ('answer_send','question_answer') then now() + interval '1 minute'
      else now()
    end,
    queue_position = default,
    processing_started_at = null,
    updated_at = now()
  where id = p_id;
end; $$;

