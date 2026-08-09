-- O servidor atual usa a chave anon no ambiente de producao. Mantem as novas
-- tabelas com o mesmo modelo de acesso das tabelas operacionais existentes.
alter table price_search_cache disable row level security;
alter table estoque_movimentacao disable row level security;
