delete from public.venda_estoque_auditoria
where venda_id = 'f1025408-13cb-4c19-9b9d-7d5f06b12163';

select public.audit_sale_inventory('f1025408-13cb-4c19-9b9d-7d5f06b12163');
