insert into settings (key, value, description)
values (
  'PALAVRAS_NEGADAS',
  '["defeito","com defeito","não funciona","nao funciona","sucata","para conserto","quebrado"]'::jsonb,
  '[PRECO] Palavras excluídas; anúncios que contenham uma delas não participam do cálculo.'
)
on conflict (key) do nothing;
