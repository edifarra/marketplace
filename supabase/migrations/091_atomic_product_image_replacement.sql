create or replace function replace_product_images_atomically(
  p_product_id uuid,
  p_images jsonb
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  image_count integer;
  existing_count integer;
  image jsonb;
begin
  if jsonb_typeof(p_images) <> 'array' then
    raise exception 'A lista final de imagens e invalida.';
  end if;

  image_count := jsonb_array_length(p_images);
  if image_count < 1 or image_count > 6 then
    raise exception 'O produto deve possuir entre 1 e 6 imagens.';
  end if;

  perform 1
    from product_images
   where product_id = p_product_id
   for update;

  if exists (
    select 1
      from jsonb_array_elements(p_images) entry
     where (entry->>'position')::integer not between 1 and 6
  ) or (
    select count(distinct (entry->>'position')::integer)
      from jsonb_array_elements(p_images) entry
  ) <> image_count then
    raise exception 'As posicoes finais das imagens sao invalidas.';
  end if;

  select count(*)
    into existing_count
    from jsonb_array_elements(p_images) entry
    join product_images current_image
      on current_image.id = (entry->>'id')::uuid
     and current_image.product_id = p_product_id
   where entry->>'kind' = 'existing';

  if existing_count <> (
    select count(*) from jsonb_array_elements(p_images) entry where entry->>'kind' = 'existing'
  ) then
    raise exception 'Uma imagem existente nao pertence mais ao produto.';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_images) entry
     where entry->>'kind' not in ('existing', 'new')
        or entry->>'id' is null
  ) then
    raise exception 'A lista final de imagens contem uma entrada invalida.';
  end if;

  update product_images
     set position = position + 1000
   where product_id = p_product_id;

  for image in select value from jsonb_array_elements(p_images)
  loop
    if image->>'kind' = 'new' then
      insert into product_images (
        id, product_id, original_name, url, cloudinary_url,
        cloudinary_public_id, cloudinary_asset_id, cloudinary_cloud_name,
        bytes, width_px, height_px, position, status
      ) values (
        (image->>'id')::uuid, p_product_id, image->>'original_name', image->>'url', image->>'cloudinary_url',
        image->>'cloudinary_public_id', nullif(image->>'cloudinary_asset_id', ''), image->>'cloudinary_cloud_name',
        (image->>'bytes')::bigint, (image->>'width_px')::integer, (image->>'height_px')::integer,
        2000 + (image->>'position')::integer, 'uploaded'
      );
    end if;
  end loop;

  delete from product_images current_image
   where current_image.product_id = p_product_id
     and not exists (
       select 1
         from jsonb_array_elements(p_images) entry
        where entry->>'kind' = 'existing'
          and (entry->>'id')::uuid = current_image.id
     )
     and not exists (
       select 1
         from jsonb_array_elements(p_images) entry
        where entry->>'kind' = 'new'
          and (entry->>'id')::uuid = current_image.id
     );

  for image in select value from jsonb_array_elements(p_images) order by (value->>'position')::integer
  loop
    update product_images
       set position = (image->>'position')::integer
     where id = (image->>'id')::uuid
       and product_id = p_product_id;
  end loop;
end;
$$;
