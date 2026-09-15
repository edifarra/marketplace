alter table listings
  add column if not exists paused_by_stock_control boolean not null default false;

comment on column listings.paused_by_stock_control is
  'Verdadeiro somente quando o sistema pausou o anuncio por falta de estoque; autoriza reativacao automatica.';
