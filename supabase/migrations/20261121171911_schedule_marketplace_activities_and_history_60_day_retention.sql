CREATE OR REPLACE FUNCTION private.cleanup_marketplace_activities_weekly()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  cutoff timestamptz := now() - interval '60 days';
  histories_deleted bigint := 0;
  activities_deleted bigint := 0;
BEGIN
  DELETE FROM public.marketplace_activity_history
  WHERE created_at < cutoff;
  GET DIAGNOSTICS histories_deleted = ROW_COUNT;

  DELETE FROM public.marketplace_activities
  WHERE received_at < cutoff;
  GET DIAGNOSTICS activities_deleted = ROW_COUNT;

  RAISE LOG 'marketplace activity retention: cutoff=%, histories_deleted_directly=%, activities_deleted=% (linked histories via cascade)',
    cutoff, histories_deleted, activities_deleted;

  RETURN jsonb_build_object('cutoff', cutoff, 'histories_deleted_directly', histories_deleted, 'activities_deleted', activities_deleted);
END;
$function$;
REVOKE ALL ON FUNCTION private.cleanup_marketplace_activities_weekly() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.cleanup_marketplace_activities_weekly() FROM anon, authenticated;
SELECT cron.schedule(
  'marketplace-activities-retention-60d-weekly',
  '0 3 * * 0',
  $cron$SELECT private.cleanup_marketplace_activities_weekly();$cron$
);;
