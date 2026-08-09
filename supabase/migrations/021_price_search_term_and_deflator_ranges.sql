alter table config_types
add column if not exists search_term text;

insert into settings (key, value, description) values
  ('FAIXA_DEFLATOR_1', '{"enabled":false,"min":0,"max":50,"value":0,"arred":false,"deflator":"valor"}'::jsonb, '[PRECO] Faixa 1 do deflator.'),
  ('FAIXA_DEFLATOR_2', '{"enabled":false,"min":51,"max":100,"value":0,"arred":false,"deflator":"valor"}'::jsonb, '[PRECO] Faixa 2 do deflator.'),
  ('FAIXA_DEFLATOR_3', '{"enabled":false,"min":101,"max":200,"value":0,"arred":false,"deflator":"valor"}'::jsonb, '[PRECO] Faixa 3 do deflator.'),
  ('FAIXA_DEFLATOR_4', '{"enabled":false,"min":201,"max":500,"value":0,"arred":false,"deflator":"valor"}'::jsonb, '[PRECO] Faixa 4 do deflator.'),
  ('FAIXA_DEFLATOR_5', '{"enabled":false,"min":501,"max":999999,"value":0,"arred":false,"deflator":"valor"}'::jsonb, '[PRECO] Faixa 5 do deflator.')
on conflict (key) do nothing;
