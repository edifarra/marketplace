alter table product_images
  add column if not exists cloudinary_asset_id text;

create index if not exists idx_product_images_cloudinary_asset_id
  on product_images(cloudinary_asset_id)
  where cloudinary_asset_id is not null;

comment on column product_images.cloudinary_asset_id is
  'Identificador imutavel retornado pelo Cloudinary para uploads novos; nulo para imagens legadas.';
