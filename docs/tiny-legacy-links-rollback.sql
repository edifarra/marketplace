-- Manual recovery only, after review. Does not reactivate Tiny (no current ID).
-- Keeps the backup and refuses to restore markers on products changed since cleanup.
BEGIN;
LOCK TABLE public.products IN SHARE ROW EXCLUSIVE MODE;
UPDATE public.products p SET sent_target = s.value->>'sent_target'
FROM public.settings s
WHERE s.key = 'TINY_LEGACY_LINK_' || p.id::text
  AND s.value->>'migration' = 'retire_legacy_tiny_markers'
  AND s.value->>'product_id' = p.id::text
  AND s.value->>'sku' = p.sku
  AND p.sent_target IS NULL
  AND nullif(btrim(p.tiny_product_id), '') IS NULL
  AND s.value->'tiny_product_id' = to_jsonb(p)->'tiny_product_id'
  AND s.value->'sent_at' = to_jsonb(p)->'sent_at'
  AND s.value->'updated_at' = to_jsonb(p)->'updated_at';
COMMIT;
