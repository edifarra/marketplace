alter table product_images
  add column if not exists local_path text,
  add column if not exists local_url text,
  add column if not exists cloudinary_url text,
  add column if not exists cloudinary_public_id text,
  add column if not exists bytes bigint;

create index if not exists idx_product_images_local_url on product_images(local_url);
create index if not exists idx_product_images_cloudinary_public_id on product_images(cloudinary_public_id);
