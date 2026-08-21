-- A stock update that arrives while the previous version is already being
-- processed must remain as a separate queued activity. Updating the processing
-- row allowed the worker to finish with its stale in-memory version and discard
-- the newer request as superseded.
drop index if exists idx_outgoing_pending_stock;

create unique index idx_outgoing_pending_stock
  on outgoing_marketplace_activities(destination, marketplace_account_id, listing_id, activity_type)
  where activity_type = 'stock_update' and status in ('queued','retry');
