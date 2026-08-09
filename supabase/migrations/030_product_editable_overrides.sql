alter table products
  add column if not exists description text,
  add column if not exists weight_net numeric(10,3),
  add column if not exists weight_gross numeric(10,3),
  add column if not exists width numeric(10,2),
  add column if not exists height numeric(10,2),
  add column if not exists length numeric(10,2);

comment on column products.description is 'Descricao particular editada pelo usuario; nulo usa o template da configuracao.';
comment on column products.weight_net is 'Peso liquido particular; nulo herda do tipo.';
comment on column products.weight_gross is 'Peso bruto particular; nulo herda do tipo.';
comment on column products.width is 'Largura particular; nulo herda do tipo.';
comment on column products.height is 'Altura particular; nulo herda do tipo.';
comment on column products.length is 'Comprimento particular; nulo herda do tipo.';
