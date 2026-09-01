with malformed as (
  select activity.id, product.height, product.width, product.length, product.weight_gross
  from outgoing_marketplace_activities activity
  join products product on product.id = activity.product_id
  where activity.destination = 'mercado_livre'
    and activity.activity_type = 'listing_update'
    and exists (
      select 1
      from jsonb_array_elements(coalesce(activity.requested_data #> '{payload,attributes}', '[]'::jsonb)) attribute
      where attribute->>'id' in ('SELLER_PACKAGE_HEIGHT', 'SELLER_PACKAGE_WIDTH', 'SELLER_PACKAGE_LENGTH', 'SELLER_PACKAGE_WEIGHT')
        and coalesce(attribute->>'value_name', '') !~ '^[0-9]+ (cm|g)$'
    )
), normalized as (
  select malformed.id, jsonb_agg(
    case attribute->>'id'
      when 'SELLER_PACKAGE_HEIGHT' then jsonb_build_object('id', 'SELLER_PACKAGE_HEIGHT', 'value_name', ceil(malformed.height)::integer || ' cm')
      when 'SELLER_PACKAGE_WIDTH' then jsonb_build_object('id', 'SELLER_PACKAGE_WIDTH', 'value_name', ceil(malformed.width)::integer || ' cm')
      when 'SELLER_PACKAGE_LENGTH' then jsonb_build_object('id', 'SELLER_PACKAGE_LENGTH', 'value_name', ceil(malformed.length)::integer || ' cm')
      when 'SELLER_PACKAGE_WEIGHT' then jsonb_build_object('id', 'SELLER_PACKAGE_WEIGHT', 'value_name', ceil(malformed.weight_gross * 1000)::integer || ' g')
      else attribute
    end order by position
  ) attributes
  from malformed
  join outgoing_marketplace_activities activity on activity.id = malformed.id
  cross join lateral jsonb_array_elements(activity.requested_data #> '{payload,attributes}') with ordinality entries(attribute, position)
  group by malformed.id
)
update outgoing_marketplace_activities activity
set requested_data = jsonb_set(activity.requested_data, '{payload,attributes}', normalized.attributes),
    status = case when activity.status = 'error' then 'retry' else activity.status end,
    attempt_count = case when activity.status = 'error' then 0 else activity.attempt_count end,
    processing_error = case when activity.status = 'error' then null else activity.processing_error end,
    processed_at = case when activity.status = 'error' then null else activity.processed_at end,
    processing_started_at = null,
    next_attempt_at = now(),
    updated_at = now()
from normalized
where activity.id = normalized.id;
