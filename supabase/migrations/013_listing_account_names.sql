-- Corrige nomes de conta gravados anteriormente como UUID em listings.
update listings as l
set marketplace_name = a.name
from config_marketplace_accounts as a
where l.marketplace_account_id = a.id
  and l.marketplace_name is distinct from a.name;
