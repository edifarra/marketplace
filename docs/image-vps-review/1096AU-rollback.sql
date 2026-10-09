-- Preparado de snapshot real em 2026-10-09T04:49:39.547Z. NÃO EXECUTADO.
-- Somente url é alterada. local_url, local_path e cloudinary_url são preservados.
-- Revisar snapshot e autorização antes de substituir ROLLBACK por COMMIT.
BEGIN;
SELECT id FROM public.product_images WHERE product_id = '19e9ed14-197c-44fb-ad64-7e98836aaea4'::uuid FOR UPDATE;
DO $review$
DECLARE affected integer;
BEGIN
  IF (SELECT count(*) FROM public.product_images WHERE product_id = '19e9ed14-197c-44fb-ad64-7e98836aaea4'::uuid) <> 3
    OR (SELECT count(*) FROM public.product_images WHERE (id IS NOT DISTINCT FROM '462d1f24-303f-483c-b4cd-b233a5b38471' AND product_id IS NOT DISTINCT FROM '19e9ed14-197c-44fb-ad64-7e98836aaea4' AND position IS NOT DISTINCT FROM 1 AND local_url IS NOT DISTINCT FROM 'https://api.gestaomarketplace.tech/Imagens/Legado/AUAI_Aws-tv-50-bl-02-a_01.jpg' AND local_path IS NOT DISTINCT FROM '/var/www/Imagens/Legado/AUAI_Aws-tv-50-bl-02-a_01.jpg' AND cloudinary_url IS NOT DISTINCT FROM 'https://res.cloudinary.com/dknfrkqol/image/upload/e_background_removal,b_white,q_auto:good,f_jpg,w_800,h_800,c_limit/produtos/AI/1096AUAU_AWS-TV-50-BL-02-A_01.jpg'
    AND url IS NOT DISTINCT FROM 'https://api.gestaomarketplace.tech/Imagens/Legado/AUAI_Aws-tv-50-bl-02-a_01.jpg') OR
    (id IS NOT DISTINCT FROM '43217e37-30fe-40a4-ad1f-8f801b04d5a4' AND product_id IS NOT DISTINCT FROM '19e9ed14-197c-44fb-ad64-7e98836aaea4' AND position IS NOT DISTINCT FROM 2 AND local_url IS NOT DISTINCT FROM 'https://api.gestaomarketplace.tech/Imagens/Legado/AUAI_Aws-tv-50-bl-02-a_02.jpg' AND local_path IS NOT DISTINCT FROM '/var/www/Imagens/Legado/AUAI_Aws-tv-50-bl-02-a_02.jpg' AND cloudinary_url IS NOT DISTINCT FROM 'https://res.cloudinary.com/dknfrkqol/image/upload/q_auto:good,w_800,h_800,c_limit,f_auto/produtos/AI/1096AUAU_AWS-TV-50-BL-02-A_02'
    AND url IS NOT DISTINCT FROM 'https://api.gestaomarketplace.tech/Imagens/Legado/AUAI_Aws-tv-50-bl-02-a_02.jpg') OR
    (id IS NOT DISTINCT FROM '1fe1f8d3-c183-4516-aa06-e8a83b20e929' AND product_id IS NOT DISTINCT FROM '19e9ed14-197c-44fb-ad64-7e98836aaea4' AND position IS NOT DISTINCT FROM 3 AND local_url IS NOT DISTINCT FROM 'https://api.gestaomarketplace.tech/Imagens/Legado/AUAI_Aws-tv-50-bl-02-a_03.jpg' AND local_path IS NOT DISTINCT FROM '/var/www/Imagens/Legado/AUAI_Aws-tv-50-bl-02-a_03.jpg' AND cloudinary_url IS NOT DISTINCT FROM 'https://res.cloudinary.com/dknfrkqol/image/upload/q_auto:good,w_800,h_800,c_limit,f_auto/produtos/AI/1096AUAU_AWS-TV-50-BL-02-A_03'
    AND url IS NOT DISTINCT FROM 'https://api.gestaomarketplace.tech/Imagens/Legado/AUAI_Aws-tv-50-bl-02-a_03.jpg')) <> 3
  THEN RAISE EXCEPTION 'Snapshot mudou: interromper e preparar nova revisão'; END IF;
  UPDATE public.product_images SET url = CASE id
      WHEN '462d1f24-303f-483c-b4cd-b233a5b38471'::uuid THEN 'https://res.cloudinary.com/dknfrkqol/image/upload/e_background_removal,b_white,q_auto:good,f_jpg,w_800,h_800,c_limit/produtos/AI/1096AUAU_AWS-TV-50-BL-02-A_01.jpg'
      WHEN '43217e37-30fe-40a4-ad1f-8f801b04d5a4'::uuid THEN 'https://res.cloudinary.com/dknfrkqol/image/upload/q_auto:good,w_800,h_800,c_limit,f_auto/produtos/AI/1096AUAU_AWS-TV-50-BL-02-A_02'
      WHEN '1fe1f8d3-c183-4516-aa06-e8a83b20e929'::uuid THEN 'https://res.cloudinary.com/dknfrkqol/image/upload/q_auto:good,w_800,h_800,c_limit,f_auto/produtos/AI/1096AUAU_AWS-TV-50-BL-02-A_03'
      ELSE url END
  WHERE product_id = '19e9ed14-197c-44fb-ad64-7e98836aaea4'::uuid;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 3 THEN RAISE EXCEPTION 'Quantidade de imagens inesperada'; END IF;
END $review$;
SELECT id, position, url, local_url, local_path, cloudinary_url FROM public.product_images
WHERE product_id = '19e9ed14-197c-44fb-ad64-7e98836aaea4'::uuid ORDER BY position;
ROLLBACK;
