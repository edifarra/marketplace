create table if not exists app_users (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  email text not null,
  password_hash text not null,
  is_master boolean not null default false,
  active boolean not null default true,
  session_version integer not null default 1,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists app_users_email_lower_unique on app_users (lower(email));

alter table app_users enable row level security;

create or replace function set_app_users_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists app_users_updated_at on app_users;
create trigger app_users_updated_at
before update on app_users
for each row execute function set_app_users_updated_at();

comment on table app_users is 'Usuarios humanos do sistema; acesso somente pelo backend com service role.';
comment on column app_users.password_hash is 'Hash scrypt com salt; nunca contem senha em texto puro.';
comment on column app_users.session_version is 'Incrementado para invalidar todas as sessoes existentes.';
