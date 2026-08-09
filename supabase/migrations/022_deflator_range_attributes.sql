update settings
set value = jsonb_build_object(
  'enabled', coalesce((value->>'enabled')::boolean, false),
  'min', coalesce((value->>'min')::numeric, 0),
  'max', coalesce((value->>'max')::numeric, 0),
  'value', coalesce((value->>'value')::numeric, 0),
  'arred', coalesce((value->>'arred')::boolean, false),
  'deflator', coalesce(nullif(lower(value->>'deflator'), ''), 'valor')
),
description = '[PRECO] Formato: {"enabled":true,"min":0,"max":50,"value":1,"arred":true,"deflator":"valor"}.'
where key in ('FAIXA_DEFLATOR_1','FAIXA_DEFLATOR_2','FAIXA_DEFLATOR_3','FAIXA_DEFLATOR_4','FAIXA_DEFLATOR_5');
