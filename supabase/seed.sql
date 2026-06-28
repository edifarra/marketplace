insert into settings(key, value, description) values
('ESTOQUE_INICIAL', '1', 'Estoque inicial por produto'),
('MAX_FOTOS', '6', 'Quantidade maxima de fotos por produto'),
('PAUSAR_COM_ESTOQUE_ZERO', 'true', 'Pausa anuncios quando o estoque fica zerado'),
('DEFINICAO_PRECO', '"MENOR"', 'MENOR, SEGUNDO, MEDIA ou MAIOR'),
('VALOR_MINIMO', '20', 'Preco minimo permitido')
on conflict (key) do update set value = excluded.value;

insert into config_brands(code, name, include_in_title) values
('TC', 'Semp TCL', false),
('PT', 'Philco', false),
('LG', 'LG', false),
('SO', 'Sony', false),
('TO', 'Semp Toshiba', false),
('SA', 'Samsung', false),
('PU', 'Philips', false)
on conflict (code) do update set name = excluded.name;

insert into config_specials(code, include_description, remove_description, keep_warranty, notes) values
('D', 'Produto com defeito, vendido no estado para conserto ou retirada de pecas.', null, false, 'Sem garantia'),
('S', null, null, true, 'Produto normal')
on conflict (code) do update set include_description = excluded.include_description;

insert into config_types(
  code, description, sku_max, marketplace_category, weight_net, weight_gross,
  width, height, length, description_template, sku_group, title_template, warranty_months
) values
('PP', 'Placa Principal TV', 1185, 'Pecas para TV > Placas Main', 0.3, 0.4, 35, 6, 30,
 '<nome_produto_completo>Produto: [NOME_PRODUTO_COMPLETO]</nome_produto_completo><br>Marca: [MARCA]<br>Placa original funcionando normalmente.<br>Garantia: 90 dias<especial>Produto vendido no estado.<br>Sem garantia</especial>',
 'PRINCIPAL', '<tipo>[TIPO]</tipo> <marca>[MARCA]</marca> <modelo>[MODELO]</modelo> <versao>[VERSAO]</versao> <codigo>[CODIGO]</codigo> <especial>[ESPECIAL]</especial>', 3),
('PF', 'Placa de Fonte TV', 722, 'Pecas para TV > Placas da Fonte TV', 0.3, 0.4, 35, 6, 30,
 '<nome_produto_completo>Produto: [NOME_PRODUTO_COMPLETO]</nome_produto_completo><br>Marca: [MARCA]<br>Placa original funcionando normalmente.<br>Garantia: 90 dias<especial>Produto vendido no estado.<br>Sem garantia</especial>',
 'FONTE', '<tipo>[TIPO]</tipo> <marca>[MARCA]</marca> <modelo>[MODELO]</modelo> <versao>[VERSAO]</versao> <codigo>[CODIGO]</codigo> <especial>[ESPECIAL]</especial>', 3),
('TC', 'Placa T-con TV', 1054, 'Pecas para TV > Placas T-con', 0.3, 0.4, 35, 6, 30,
 '<nome_produto_completo>Produto: [NOME_PRODUTO_COMPLETO]</nome_produto_completo><br>Marca: [MARCA]<br>Placa original funcionando normalmente.<br>Garantia: 90 dias<especial>Produto vendido no estado.<br>Sem garantia</especial>',
 'TCON', '<tipo>[TIPO]</tipo> <marca>[MARCA]</marca> <modelo>[MODELO]</modelo> <versao>[VERSAO]</versao> <codigo>[CODIGO]</codigo> <especial>[ESPECIAL]</especial>', 3)
on conflict (code) do update set description = excluded.description;

insert into sku_counters(sku_group, current_number) values
('PRINCIPAL', 1185),
('FONTE', 722),
('TCON', 1054)
on conflict (sku_group) do update set current_number = excluded.current_number;
