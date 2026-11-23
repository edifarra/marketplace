
create table if not exists public.config_frete_flex (
  id uuid primary key default gen_random_uuid(),
  chave text not null unique default 'padrao' check (chave = 'padrao'),
  custo_capital_grande_sp numeric(12,2) not null default 12.70 check (custo_capital_grande_sp >= 0),
  custo_extremo_sp numeric(12,2) not null default 16.97 check (custo_extremo_sp >= 0),
  percentual_gris numeric(7,4) not null default 0.10 check (percentual_gris between 0 and 100),
  percentual_ad_valorem numeric(7,4) not null default 0.10 check (percentual_ad_valorem between 0 and 100),
  adicional_kg_acima_10 numeric(12,2) not null default 1.00 check (adicional_kg_acima_10 >= 0),
  peso_limite_kg numeric(8,2) not null default 10 check (peso_limite_kg > 0),
  ativo boolean not null default true,
  observacoes text,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
create table if not exists public.config_frete_flex_cidades_extremo (
  id uuid primary key default gen_random_uuid(),
  configuracao_id uuid not null references public.config_frete_flex(id) on delete restrict,
  cidade text not null check (length(trim(cidade)) > 0),
  cidade_normalizada text generated always as (lower(trim(cidade))) stored,
  uf char(2) not null default 'SP' check (uf = 'SP'),
  ativo boolean not null default true,
  observacoes text,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  unique (configuracao_id, uf, cidade_normalizada)
);
create index if not exists idx_config_frete_flex_extremo_busca
on public.config_frete_flex_cidades_extremo(configuracao_id, uf, cidade_normalizada)
where ativo;
alter table public.config_frete_flex enable row level security;
alter table public.config_frete_flex_cidades_extremo enable row level security;
revoke all on public.config_frete_flex from public, anon, authenticated;
revoke all on public.config_frete_flex_cidades_extremo from public, anon, authenticated;
grant select, insert, update, delete on public.config_frete_flex to service_role;
grant select, insert, update, delete on public.config_frete_flex_cidades_extremo to service_role;
insert into public.config_frete_flex (chave, observacoes)
values ('padrao','Tarifas faturadas observadas na fatura TM Logística 01-15/10/2026. Percentuais são valores percentuais (0,10 = 0,10%). Classificação por cidade; destino não listado utiliza tarifa normal. Não altera histórico.')
on conflict (chave) do nothing;
insert into public.config_frete_flex_cidades_extremo(configuracao_id,cidade,observacoes)
select c.id, v.cidade, 'Município incluído na região Grande SP Extremo da tabela TM Logística'
from public.config_frete_flex c cross join (values
('Arujá'),('Caieiras'),('Franco da Rocha'),('Itapevi'),('Jandira'),('Ferraz de Vasconcelos'),('Poá'),
('Mogi das Cruzes'),('Suzano'),('Santana de Parnaíba')
) as v(cidade)
where c.chave = 'padrao'
on conflict (configuracao_id, uf, cidade_normalizada) do nothing;
;
