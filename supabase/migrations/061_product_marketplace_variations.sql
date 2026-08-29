create table if not exists public.product_marketplace_variations (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references public.products(id) on delete cascade,
  marketplace_account_id uuid not null references public.config_marketplace_accounts(id) on delete cascade,
  marketplace marketplace_code not null,
  parent_listing_id text not null,
  variation_id text not null,
  sku text not null,
  raw_data jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (marketplace_account_id, parent_listing_id, variation_id)
);

create index if not exists idx_product_marketplace_variations_product
  on public.product_marketplace_variations(product_id, marketplace_account_id, parent_listing_id);
create index if not exists idx_product_marketplace_variations_sku
  on public.product_marketplace_variations(upper(btrim(sku)));

alter table public.product_marketplace_variations enable row level security;
revoke all on table public.product_marketplace_variations from anon, authenticated;
grant all on table public.product_marketplace_variations to service_role;

-- Conserva os vínculos ML-ED já confirmados e gravados no cadastro legado.
insert into public.product_marketplace_variations
  (product_id, marketplace_account_id, marketplace, parent_listing_id, variation_id, sku)
select distinct on (a.id, p.mercado_livre_parent_listing_id, p.mercado_livre_variation_id)
       p.id, a.id, 'mercado_livre', p.mercado_livre_parent_listing_id,
       p.mercado_livre_variation_id::text, p.sku
from public.products p
join public.config_marketplace_accounts a on a.name = 'ML-ED'
where p.mercado_livre_parent_listing_id is not null
  and p.mercado_livre_variation_id is not null
order by a.id, p.mercado_livre_parent_listing_id, p.mercado_livre_variation_id, p.created_at
on conflict (marketplace_account_id, parent_listing_id, variation_id) do update
set product_id = excluded.product_id, sku = excluded.sku, updated_at = now();

-- O anúncio abaixo possui quatro variações com o mesmo SKU; a tabela normalizada
-- permite preservar todas sem escolher uma variação arbitrária.
with ml_ed_duplicates(parent_id, variation_id, sku) as (values
  ('MLB3571406276', '178025008971', '4EQRN10EN'),
  ('MLB3571406276', '178025008973', '4EQRN10EN'),
  ('MLB3571406276', '178025008975', '4EQRN10EN'),
  ('MLB3571406276', '178025008977', '4EQRN10EN')
)
insert into public.product_marketplace_variations
  (product_id, marketplace_account_id, marketplace, parent_listing_id, variation_id, sku)
select p.id, a.id, 'mercado_livre', v.parent_id, v.variation_id, v.sku
from ml_ed_duplicates v
join public.products p on upper(btrim(p.sku)) = upper(btrim(v.sku))
join public.config_marketplace_accounts a on a.name = 'ML-ED'
on conflict (marketplace_account_id, parent_listing_id, variation_id) do update
set product_id = excluded.product_id, sku = excluded.sku, updated_at = now();

with variation_links(account_name, marketplace, parent_id, variation_id, sku) as (values
  ('ML-GI', 'mercado_livre'::marketplace_code, 'MLB5512448586', '189130164833', 'GIR181-Branco'),
  ('ML-GI', 'mercado_livre'::marketplace_code, 'MLB5512448586', '189130164831', 'GIR181-RosaMetal'),
  ('ML-GI', 'mercado_livre'::marketplace_code, 'MLB5512448586', '189130164829', 'GIR181-RosaSilicone'),
  ('ML-GI', 'mercado_livre'::marketplace_code, 'MLB4063881089', '183623242074', 'GIR169.15052025-Branco'),
  ('ML-GI', 'mercado_livre'::marketplace_code, 'MLB4063881089', '183623242076', 'GIR169.15052025-Preto'),
  ('ML-GI', 'mercado_livre'::marketplace_code, 'MLB5652741794', '190254604167', 'GIR196-AZUL'),
  ('ML-GI', 'mercado_livre'::marketplace_code, 'MLB5652741794', '190254604169', 'GIR196-VERMELHO'),
  ('ML-GI', 'mercado_livre'::marketplace_code, 'MLB5499102656', '189019334909', 'GIR56-Verde'),
  ('ML-GI', 'mercado_livre'::marketplace_code, 'MLB5499102656', '189019334903', 'GIR56-PretoSilicone'),
  ('ML-GI', 'mercado_livre'::marketplace_code, 'MLB5499102656', '189019334907', 'GIR56-Branco'),
  ('ML-GI', 'mercado_livre'::marketplace_code, 'MLB5499102656', '189019334905', 'GIR56-Laranja'),
  ('ML-GI', 'mercado_livre'::marketplace_code, 'MLB5499102656', '189019334911', 'GIR56-CinzaClaro'),
  ('ML-GI', 'mercado_livre'::marketplace_code, 'MLB5499102656', '189019334913', 'GIR56-Nylon'),
  ('ML-GI', 'mercado_livre'::marketplace_code, 'MLB5499102656', '189030960887', 'GIR56-Azul'),
  ('ML-GI', 'mercado_livre'::marketplace_code, 'MLB5499102656', '189035019519', 'GIR56-CinzaEscuro'),
  ('ML-GI', 'mercado_livre'::marketplace_code, 'MLB5224536684', '182550089672', 'GIR33'),
  ('ML-GI', 'mercado_livre'::marketplace_code, 'MLB5224536684', '186629145999', 'VD41'),
  ('ML-GI', 'mercado_livre'::marketplace_code, 'MLB5230917826', '186509867707', 'GIR47'),
  ('ML-GI', 'mercado_livre'::marketplace_code, 'MLB5230917826', '186509867709', 'GIR48'),
  ('ML-GI', 'mercado_livre'::marketplace_code, 'MLB5386374186', '183598799260', 'GIR15513052025-Preto'),
  ('ML-GI', 'mercado_livre'::marketplace_code, 'MLB5386374186', '183598799262', 'GIR15513052025-Branco'),
  ('ML-GI', 'mercado_livre'::marketplace_code, 'MLB5399294748', '188064330565', 'GIR171.21052025Branco'),
  ('ML-GI', 'mercado_livre'::marketplace_code, 'MLB5399294748', '188064330567', 'GIR171.21052025-Preto'),
  ('ML-GI', 'mercado_livre'::marketplace_code, 'MLB3647437906', '177747873810', 'N204N10'),
  ('ML-GI', 'mercado_livre'::marketplace_code, 'MLB3647437906', '177747873812', 'N204N10'),
  ('ML-GI', 'mercado_livre'::marketplace_code, 'MLB3647437906', '177747873814', 'N204N10'),
  ('ML-GI', 'mercado_livre'::marketplace_code, 'MLB3647437906', '177747873816', 'N204N10'),
  ('ML-GI', 'mercado_livre'::marketplace_code, 'MLB3647437906', '177747873818', 'N204MD3EN'),
  ('ML-GI', 'mercado_livre'::marketplace_code, 'MLB3647437906', '177747873820', 'N204MD3EN'),
  ('ML-GI', 'mercado_livre'::marketplace_code, 'MLB3647437906', '177747873822', 'N204MD3EN'),
  ('ML-GI', 'mercado_livre'::marketplace_code, 'MLB3647437906', '177747873824', 'N204MD3EN'),
  ('ML-GI', 'mercado_livre'::marketplace_code, 'MLB5605484842', '184832893220', 'GIR188-PretoBranco'),
  ('ML-GI', 'mercado_livre'::marketplace_code, 'MLB5605484842', '184832893222', 'GIR188-PretoRosa'),
  ('ML-GI', 'mercado_livre'::marketplace_code, 'MLB5619611184', '184888549142', 'GIR190-Preto'),
  ('ML-GI', 'mercado_livre'::marketplace_code, 'MLB5619611184', '184888549144', 'GIR190-Roxo'),
  ('ML-GI', 'mercado_livre'::marketplace_code, 'MLB5619611184', '184888549146', 'GIR190-Azul'),
  ('SP-ED', 'shopee'::marketplace_code, '23598510805', '149546197818', 'GIR167-15'),
  ('SP-ED', 'shopee'::marketplace_code, '23598510805', '149546197819', 'GIR167-14Pro'),
  ('SP-ED', 'shopee'::marketplace_code, '23598510805', '149546197820', 'GIR167-14ProMax'),
  ('SP-ED', 'shopee'::marketplace_code, '23598510805', '149546197817', 'GIR167-15Plus'),
  ('SP-ED', 'shopee'::marketplace_code, '22994356486', '229427527824', 'GIR196-AZUL'),
  ('SP-ED', 'shopee'::marketplace_code, '22994356486', '229427527825', 'GIR196-VERMELHO'),
  ('SP-ED', 'shopee'::marketplace_code, '23793971613', '219607295456', 'GIR15513052025-Preto'),
  ('SP-ED', 'shopee'::marketplace_code, '23793971613', '219607295457', 'GIR15513052025-Branco'),
  ('SP-ED', 'shopee'::marketplace_code, '22798480208', '228784621570', 'GIR169.15052025-Preto'),
  ('SP-ED', 'shopee'::marketplace_code, '22798480208', '228784621569', 'GIR169.15052025-Branco'),
  ('SP-ED', 'shopee'::marketplace_code, '18899049934', '159536723215', '4FEFN10EN/P'),
  ('SP-ED', 'shopee'::marketplace_code, '18899049934', '159536723216', '4FEFN10EN/M'),
  ('SP-ED', 'shopee'::marketplace_code, '18899049934', '159536723217', '4FEFN10EN/G'),
  ('SP-ED', 'shopee'::marketplace_code, '18899049934', '159536723218', '4FEFN10EN/XG'),
  ('SP-ED', 'shopee'::marketplace_code, '18899049934', '159536723211', '4FEFN0AEN/P'),
  ('SP-ED', 'shopee'::marketplace_code, '18899049934', '159536723212', '4FEFN0AEN/M'),
  ('SP-ED', 'shopee'::marketplace_code, '18899049934', '159536723213', '4FEFN0AEN/G'),
  ('SP-ED', 'shopee'::marketplace_code, '18899049934', '159536723214', '4FEFN0AEN/XG'),
  ('SP-ED', 'shopee'::marketplace_code, '21099031565', '159536724053', 'N204N1007S/P'),
  ('SP-ED', 'shopee'::marketplace_code, '21099031565', '159536724054', 'N204N1007S/XG'),
  ('SP-ED', 'shopee'::marketplace_code, '21099031565', '159536724055', 'N204MD3EN/P'),
  ('SP-ED', 'shopee'::marketplace_code, '21099031565', '159536724056', 'N204MD3EN/G'),
  ('SP-ED', 'shopee'::marketplace_code, '21099031565', '159536724049', 'N204N1007S/G'),
  ('SP-ED', 'shopee'::marketplace_code, '21099031565', '159536724050', 'N204MD3EN/M'),
  ('SP-ED', 'shopee'::marketplace_code, '21099031565', '159536724051', 'N204N1007S/M'),
  ('SP-ED', 'shopee'::marketplace_code, '21099031565', '159536724052', 'N204MD3EN/XG'),
  ('SP-ED', 'shopee'::marketplace_code, '21099031545', '159774754652', '0299MD3EN/XG'),
  ('SP-ED', 'shopee'::marketplace_code, '21099031545', '159774754648', '0299N1007S/M'),
  ('SP-ED', 'shopee'::marketplace_code, '21099031545', '159774754656', '0299N0A00S/XG'),
  ('SP-ED', 'shopee'::marketplace_code, '21099031545', '159774754653', '0299N1007S/P'),
  ('SP-ED', 'shopee'::marketplace_code, '21099031545', '159774754658', '0299MD3EN/G'),
  ('SP-ED', 'shopee'::marketplace_code, '21099031545', '159774754649', '0299N1007S/G'),
  ('SP-ED', 'shopee'::marketplace_code, '21099031545', '159774754659', '0299N1007S/XG'),
  ('SP-ED', 'shopee'::marketplace_code, '21099031545', '159774754655', '0299N0A00S/G'),
  ('SP-ED', 'shopee'::marketplace_code, '21099031545', '159774754650', '0299N0A00S/M'),
  ('SP-ED', 'shopee'::marketplace_code, '21099031545', '159774754651', '0299MD3EN/P'),
  ('SP-ED', 'shopee'::marketplace_code, '21099031545', '159774754657', '0299MD3EN/M'),
  ('SP-ED', 'shopee'::marketplace_code, '21099031545', '159774754654', '0299N0A00S/P'),
  ('SP-ED', 'shopee'::marketplace_code, '22197604907', '219163648418', '022BN0A00S/G'),
  ('SP-ED', 'shopee'::marketplace_code, '22197604907', '219163648417', '022BN0A00S/M'),
  ('SP-ED', 'shopee'::marketplace_code, '22197604907', '219163648412', 'N1007S/G'),
  ('SP-ED', 'shopee'::marketplace_code, '22197604907', '219163648419', 'N1007S/M'),
  ('SP-ED', 'shopee'::marketplace_code, '22197604907', '219163648423', '022BAX7EN/XG'),
  ('SP-ED', 'shopee'::marketplace_code, '22197604907', '219163648420', '022BN0A00S/XG'),
  ('SP-ED', 'shopee'::marketplace_code, '22197604907', '219163648413', '022BAX7EN/P'),
  ('SP-ED', 'shopee'::marketplace_code, '22197604907', '219163648414', '022BAX7EN/M'),
  ('SP-ED', 'shopee'::marketplace_code, '22197604907', '219163648415', '022BAX7EN/G'),
  ('SP-ED', 'shopee'::marketplace_code, '22197604907', '219163648422', 'N1007S/XG'),
  ('SP-ED', 'shopee'::marketplace_code, '22197604907', '219163648421', 'N1007S/P'),
  ('SP-ED', 'shopee'::marketplace_code, '22197604907', '219163648416', '022BN0A00S/P'),
  ('SP-GI', 'shopee'::marketplace_code, '22994014614', '159784224397', 'GIR169.15052025-Branco'),
  ('SP-GI', 'shopee'::marketplace_code, '22994014614', '159784224398', 'GIR169.15052025-Preto'),
  ('SP-GI', 'shopee'::marketplace_code, '23897589857', '189596091355', 'RE01Preto'),
  ('SP-GI', 'shopee'::marketplace_code, '23194357345', '119725175618', 'GIR196-AZUL'),
  ('SP-GI', 'shopee'::marketplace_code, '23194357345', '119725175619', 'GIR196-VERMELHO'),
  ('SP-GI', 'shopee'::marketplace_code, '23893442571', '179405758886', 'GIR15513052025-Preto'),
  ('SP-GI', 'shopee'::marketplace_code, '23893442571', '179405758885', 'GIR15513052025-Branco')
)
insert into public.product_marketplace_variations
  (product_id, marketplace_account_id, marketplace, parent_listing_id, variation_id, sku)
select distinct on (a.id, v.parent_id, v.variation_id)
       p.id, a.id, v.marketplace, v.parent_id, v.variation_id, v.sku
from variation_links v
join public.config_marketplace_accounts a on a.name = v.account_name
join public.products p on upper(btrim(p.sku)) = upper(btrim(v.sku))
order by a.id, v.parent_id, v.variation_id, p.created_at
on conflict (marketplace_account_id, parent_listing_id, variation_id) do update
set product_id = excluded.product_id,
    marketplace = excluded.marketplace,
    sku = excluded.sku,
    updated_at = now();
