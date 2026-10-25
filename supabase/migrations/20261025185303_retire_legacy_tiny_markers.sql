-- Atomic, bounded cleanup. No products or commercial records are deleted.
-- The row lock keeps backup and update on the same product version.
DO $$
DECLARE affected integer;
BEGIN
  LOCK TABLE public.products IN SHARE ROW EXCLUSIVE MODE;
  PERFORM id FROM public.products
    WHERE sent_target = 'TINY' AND nullif(btrim(tiny_product_id), '') IS NULL
    FOR UPDATE;
  SELECT count(*) INTO affected FROM public.products
    WHERE sent_target = 'TINY' AND nullif(btrim(tiny_product_id), '') IS NULL;
  IF affected > 3235 THEN
    RAISE EXCEPTION 'Tiny cleanup exceeds audited limit: % (maximum 3235)', affected;
  END IF;

  INSERT INTO public.settings (key, value, description)
  SELECT 'TINY_LEGACY_LINK_' || id::text,
    jsonb_build_object('product_id', id, 'sku', sku, 'sent_target', sent_target,
      'sent_at', sent_at, 'tiny_product_id', tiny_product_id, 'updated_at', updated_at,
      'archived_at', now(), 'migration', 'retire_legacy_tiny_markers'),
    '[TINY] Marcador legado aposentado; backup para recuperação, sem vínculo operacional'
  FROM public.products
  WHERE sent_target = 'TINY' AND nullif(btrim(tiny_product_id), '') IS NULL
  ON CONFLICT (key) DO NOTHING;

  -- Refuse to clear a marker if a pre-existing backup does not match this row.
  IF EXISTS (
    SELECT 1 FROM public.products p JOIN public.settings s ON s.key = 'TINY_LEGACY_LINK_' || p.id::text
    WHERE p.sent_target = 'TINY' AND nullif(btrim(p.tiny_product_id), '') IS NULL
      AND (s.value->>'migration' IS DISTINCT FROM 'retire_legacy_tiny_markers'
        OR s.value->>'product_id' IS DISTINCT FROM p.id::text
        OR s.value->>'sku' IS DISTINCT FROM p.sku
        OR s.value->>'sent_target' IS DISTINCT FROM p.sent_target
        OR s.value->'sent_at' IS DISTINCT FROM to_jsonb(p)->'sent_at'
        OR s.value->'tiny_product_id' IS DISTINCT FROM to_jsonb(p)->'tiny_product_id'
        OR s.value->'updated_at' IS DISTINCT FROM to_jsonb(p)->'updated_at')
  ) THEN RAISE EXCEPTION 'Tiny cleanup backup conflict; no markers changed'; END IF;

  UPDATE public.products SET sent_target = NULL
  WHERE sent_target = 'TINY' AND nullif(btrim(tiny_product_id), '') IS NULL;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RAISE NOTICE 'Retired % legacy Tiny markers; previous values saved in settings', affected;
END $$;
