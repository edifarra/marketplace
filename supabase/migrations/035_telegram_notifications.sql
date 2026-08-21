create table if not exists telegram_notification_config (
  id boolean primary key default true check (id),
  enabled boolean not null default false,
  bot_token_encrypted text,
  chat_id text,
  recipient_name text,
  timezone text not null default 'America/Sao_Paulo',
  new_sale_enabled boolean not null default false,
  new_sale_start time not null default '11:50',
  new_sale_end time not null default '13:00',
  dispatch_enabled boolean not null default false,
  dispatch_check_time time not null default '16:30',
  updated_at timestamptz not null default now(),
  updated_by uuid references app_users(id) on delete set null
);

insert into telegram_notification_config(id) values (true) on conflict (id) do nothing;

create table if not exists telegram_notification_history (
  id uuid primary key default gen_random_uuid(),
  alert_type text not null check (alert_type in ('test', 'new_sale', 'pending_dispatch')),
  sale_id uuid references venda(id) on delete set null,
  order_id text,
  marketplace text,
  account_name text,
  notification_date date not null,
  idempotency_key text not null unique,
  status text not null check (status in ('sent', 'error', 'ignored')),
  telegram_message_id text,
  error_message text,
  created_at timestamptz not null default now()
);

create index if not exists telegram_notification_history_created_idx
  on telegram_notification_history(created_at desc);

create table if not exists telegram_notification_jobs (
  job_name text not null,
  run_date date not null,
  status text not null check (status in ('running', 'completed', 'error')),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  error_message text,
  primary key(job_name, run_date)
);

alter table telegram_notification_config enable row level security;
alter table telegram_notification_history enable row level security;
alter table telegram_notification_jobs enable row level security;

comment on column telegram_notification_config.bot_token_encrypted is
  'Token do bot cifrado no backend; nunca retornado ao navegador.';
