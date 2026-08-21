-- Corrige o gatilho criado na migration 038. A coluna estoque_reservado nao
-- existe: a reserva e representada pela diferenca entre os saldos fisico e
-- disponivel.
create or replace function increment_stock_version()
returns trigger
language plpgsql
as $$
begin
  if row(new.estoque_fisico, new.estoque_disponivel)
     is distinct from row(old.estoque_fisico, old.estoque_disponivel) then
    new.stock_version := old.stock_version + 1;
  end if;
  return new;
end;
$$;

-- Reabre exclusivamente os eventos interrompidos pelo gatilho defeituoso.
-- O reconciliador de estoque usa os marcadores da venda para garantir que o
-- reprocessamento nao reserve nem desconte o mesmo pedido duas vezes.
update marketplace_activities
   set status = 'queued',
       attempt_count = 0,
       processing_error = null,
       processed_at = null,
       processing_started_at = null,
       next_attempt_at = now(),
       locked_at = null
 where processing_error = 'record "new" has no field "estoque_reservado"'
   and status in ('error', 'retry', 'processing');
