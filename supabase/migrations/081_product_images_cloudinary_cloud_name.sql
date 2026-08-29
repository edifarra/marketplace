alter table product_images
  add column if not exists cloudinary_cloud_name text;

update product_images
set cloudinary_cloud_name = substring(coalesce(cloudinary_url, url) from 'res\.cloudinary\.com/([^/]+)')
where cloudinary_cloud_name is null
  and coalesce(cloudinary_url, url) like '%res.cloudinary.com/%';

comment on column product_images.cloudinary_cloud_name is 'Cloud name da conta Cloudinary que armazena a imagem.';
