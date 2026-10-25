-- Append-only financial evidence. No grants/policies for browser roles.
create table public.financial_import_runs (
 id uuid primary key,
 started_at timestamptz not null default now(),
 finished_at timestamptz,
 period_start timestamptz not null,
 period_end timestamptz not null,
 collector_version text not null,
 status text not null check (status in ('running','complete','partial','failed')),
 summary jsonb not null default '{}'::jsonb,
 check (period_start >= '2026-10-01T03:00:00Z' and period_end <= '2026-10-26T03:00:00Z' and period_end > period_start)
);
create table public.financial_api_responses (
 id uuid primary key,
 run_id uuid not null references public.financial_import_runs(id),
 account_id uuid not null references public.config_marketplace_accounts(id),
 source text not null,
 endpoint text not null,
 request_parameters jsonb not null,
 http_status integer not null,
 collected_at timestamptz not null,
 response_headers jsonb not null,
 body_base64 text not null,
 body_sha256 text not null check (body_sha256 ~ '^[a-f0-9]{64}$'),
 unique (id, account_id, source)
);
create table public.financial_statement_entries (
 id uuid primary key,
 account_id uuid not null references public.config_marketplace_accounts(id),
 account_name text not null check(account_name in ('ML-ED','ML-GI','SP-ED','SP-GI')),
 source text not null,
 semantic text not null,
 external_id text not null,
 occurred_at timestamptz not null,
 date_basis text not null,
 currency text,
 currency_basis text not null,
 amount numeric,
 signed_amount numeric,
 direction text not null check(direction in ('credit','debit','zero','unknown')),
 amounts jsonb not null,
 original_payload jsonb not null,
 original_line text,
 payload_sha256 text not null check(payload_sha256 ~ '^[a-f0-9]{64}$'),
 response_id uuid not null,
 collected_at timestamptz not null,
 foreign key(response_id,account_id,source) references public.financial_api_responses(id,account_id,source),
 unique(account_id,source,semantic,external_id,payload_sha256),
 check(occurred_at >= '2026-10-01T03:00:00Z' and occurred_at < '2026-10-26T03:00:00Z'),
 check ((signed_amount is null and direction='unknown') or (signed_amount > 0 and direction='credit') or (signed_amount < 0 and direction='debit') or (signed_amount=0 and direction='zero'))
);
create index financial_entries_account_time_idx on public.financial_statement_entries(account_id,source,semantic,occurred_at);
create index financial_entries_external_idx on public.financial_statement_entries(account_id,source,external_id);
create index financial_responses_run_idx on public.financial_api_responses(run_id);
create index financial_responses_account_idx on public.financial_api_responses(account_id,source,collected_at);
create index financial_entries_response_idx on public.financial_statement_entries(response_id,account_id,source);
alter table public.financial_import_runs enable row level security;
alter table public.financial_import_runs force row level security;
alter table public.financial_api_responses enable row level security;
alter table public.financial_api_responses force row level security;
alter table public.financial_statement_entries enable row level security;
alter table public.financial_statement_entries force row level security;
revoke all on public.financial_import_runs,public.financial_api_responses,public.financial_statement_entries from public,anon,authenticated,service_role;
grant select,insert on public.financial_api_responses,public.financial_statement_entries to service_role;
grant select,insert on public.financial_import_runs to service_role;
grant update(finished_at,status,summary) on public.financial_import_runs to service_role;
comment on table public.financial_statement_entries is 'Immutable observations, versioned by payload hash. Sources/semantics overlap: never sum across them. Missing currency/sign remain unknown. No retention cleanup.';
comment on table public.financial_api_responses is 'Complete original response bytes (base64), SHA256, safe request metadata; credentials are excluded. Append only.';
