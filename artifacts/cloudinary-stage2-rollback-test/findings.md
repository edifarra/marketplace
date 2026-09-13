# Cloudinary — validação descartável de backup, overwrite e restore

Data: 2026-09-13

## Resultado

O ciclo completo foi validado exclusivamente no asset descartável `testes/cloudinary-stage2-rollback-1789274578133`. Nenhum dos 860 assets reais, banco, produto ou marketplace foi alterado.

O backup global aparenta estar desligado: assets reais consultados anteriormente retornaram `backup=false`. O parâmetro individual `backup=true` sobrepôs essa configuração e funcionou no plano atual.

## Evidências

- Upload inicial: `asset_id=93250639811af6628f284589298df556`, versão `1789274581`, `version_id=b7c5b0f07e2b97736bfdb162a40e15b8`, PNG 640×420, 14.307 bytes.
- Download do backup: 14.307 bytes; SHA-256 `e07d3ca00676537f9be00721438b20937b3bcd4d0515deb44bf2b966cb2c5c84`, idêntico ao arquivo local.
- Overwrite: mesmo `public_id` e mesmo `asset_id`; versão `1789274582`, novo `version_id=4ce93330ecbfdcb68a7c037a912aa0c3`, PNG 920×560, 15.571 bytes.
- URL antiga versionada: HTTP 200, mas entregou a versão nova (SHA-256 novo), não conteúdo histórico.
- URL nova versionada: entregou a versão nova.
- URL sem versão: entregou a versão nova.
- URL transformada: PNG 240×146, 2.402 bytes; derivado distinto.
- As quatro verificações terminaram 1.252 ms após o overwrite. Nesta amostra, a invalidação já estava refletida na primeira consulta; isso não garante o mesmo tempo globalmente.
- Restore pelo `version_id` inicial: versão atual passou para `1789274585`, dimensões retornaram a 640×420 e SHA-256 ficou exatamente igual ao original.

## Storage do teste

Após o restore ficaram registrados três version IDs, com tamanhos conhecidos de 14.307, 15.571 e 14.307 bytes, além de um derivado de 5.402 bytes visto na Admin API. O endpoint `/usage` retornou o mesmo total antes/depois (3.356.755.576 bytes), portanto não tem resolução/atualização imediata suficiente para atribuir os poucos KB deste teste.

Inferência conservadora: o histórico representa 44.185 bytes de versões e o derivado 5.402 bytes. Como a documentação afirma que backups contam na quota, overwrite reduz o original ativo, mas mantém pelo menos a versão anterior no backup. A API permite excluir version IDs específicos com `DELETE /resources/backup/:asset_id`; isso não foi executado porque é irreversível.

## Cenários para os 860 assets

Base: atuais 1.756,24 MiB; otimizados 446,53 MiB; economia bruta 1.309,71 MiB.

### A — backup nativo mantido indefinidamente

- Ativo otimizado: 446,53 MiB.
- Backup do original antigo: 1.756,24 MiB.
- Se a cópia da versão atual também for contabilizada como backup: mais 446,53 MiB.
- Total conservador: entre 2.202,77 e 2.649,30 MiB.
- Economia líquida: negativa; entre −446,53 e −893,06 MiB frente ao estado atual.

### B — backup temporário e exclusão após validação

- Durante a janela: mesma faixa conservadora do cenário A.
- Depois de excluir os version IDs antigos: 446,53 MiB ativos; potencialmente mais 446,53 MiB se o backup da versão atual for mantido.
- Total final: entre 446,53 e 893,06 MiB.
- Economia líquida final: entre 863,18 e 1.309,71 MiB.

### C — backup externo/local verificado, sem backup nativo permanente

- Cloudinary após otimização: aproximadamente 446,53 MiB.
- Backup externo: aproximadamente 1.756,24 MiB, mais manifestos/hashes desprezíveis.
- Economia líquida no Cloudinary: aproximadamente 1.309,71 MiB.
- Rollback é viável por reupload dos bytes originais, mas cria uma nova versão e depende da integridade, disponibilidade e segurança do armazenamento externo. URLs antigas continuam apontando para o asset lógico e, com invalidação, entregam a versão restaurada.

## Recomendação

Recomenda-se o cenário B para o primeiro piloto real: `backup=true` individual, guardar também backup externo com SHA-256, validar cada asset e manter o backup nativo por uma janela curta. Depois, excluir somente os version IDs antigos mediante uma segunda autorização e uma lista imutável de IDs. Para o lote futuro, o cenário C pode oferecer a maior economia, mas apenas depois de validar restauração externa no piloto real.

Ainda impedem o piloto real: definir a janela de retenção, confirmar por medição maior como a quota contabiliza a versão atual em backup e aprovar explicitamente o procedimento irreversível de exclusão dos version IDs antigos. O mecanismo atual também precisa ser ajustado para aceitar `backup=true` individual como rollback válido, pois hoje bloqueia assets cuja configuração anterior era `backup=false`.

## Recursos deixados no Cloudinary

- Asset atual: presente, restaurado ao PNG original 640×420, 14.307 bytes.
- Backups/version IDs: três registros no histórico.
- Derivado: `w_240,h_240,c_limit`, 5.402 bytes.
- Nada foi removido. A limpeza só deve ocorrer depois de preservar este relatório. Excluir o asset inteiro pode ser feito pelo Upload API `destroy` com o public ID descartável e `invalidate=true`; versões de backup específicas podem ser excluídas pela Admin API, operação irreversível.
