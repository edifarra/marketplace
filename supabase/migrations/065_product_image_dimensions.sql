alter table product_images
  add column if not exists width_px integer,
  add column if not exists height_px integer;

comment on column product_images.width_px is 'Largura em pixels da imagem processada enviada aos marketplaces.';
comment on column product_images.height_px is 'Altura em pixels da imagem processada enviada aos marketplaces.';
