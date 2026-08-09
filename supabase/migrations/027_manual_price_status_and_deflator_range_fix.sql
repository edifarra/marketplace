alter type product_status add value if not exists 'manual_price';

update settings
set value = '{"max":160,"min":110.01,"arred":false,"value":10,"enabled":true,"deflator":"valor"}'::jsonb,
    updated_at = now()
where key = 'FAIXA_DEFLATOR_3'
  and value #>> '{}' like '%"value"10%';
