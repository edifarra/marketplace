update public.products
set mercado_livre_parent_listing_id = 'MLB5512385604',
    mercado_livre_variation_id = case upper(btrim(sku))
      when 'GIR181-BRANCO' then 184356019366
      when 'GIR181-ROSAMETAL' then 184356019364
      when 'GIR181-ROSASILICONE' then 184356019362
    end,
    updated_at = now()
where upper(btrim(sku)) in (
  'GIR181-BRANCO',
  'GIR181-ROSAMETAL',
  'GIR181-ROSASILICONE'
);
