alter table public.config_types
  add column if not exists marketplace_active_attributes jsonb;

comment on column public.config_types.marketplace_active_attributes is
  'Lista de atributos de categoria ativos por marketplace. NULL preserva todos os atributos ativos para tipos anteriores.';
