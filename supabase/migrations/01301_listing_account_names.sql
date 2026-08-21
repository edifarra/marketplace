-- Corrige nomes de conta gravados anteriormente como UUID em listings.
-- O identificador 01301 evita a colisao historica com a migration 013.
update listings as l
set marketplace_name = a.name
from config_marketplace_accounts as a
where l.marketplace_account_id = a.id
  and l.marketplace_name is distinct from a.name;
