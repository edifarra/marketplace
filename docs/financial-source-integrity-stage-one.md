# Etapa 1 — integridade da origem financeira

Implementação local, sem publicação. Nenhum backfill, reimportação, escrita de negócio no Supabase, migration, alteração de conta, novo agendamento, menu Financeiro ou chamada ao `release_report` foi executado.

## Causas comprovadas e mudanças

| Inconsistência | Classe | Causa atual | Correção e persistência |
|---|---|---|---|
| 70 campos textuais GI | A/C | `csvRecords` alternava o estado para toda aspa, eliminando aspas JSON internas. O arquivo também contém JSON não envolvido por aspas externas. | `scripts/financial-import-core.mjs` aceita RFC e os dois dialetos JSON comprovados somente quando o campo inteiro é JSON válido. Bytes e linha originais permanecem evidência. |
| Versão do extrato | A | Último elemento da lista não significa relatório mais novo. Hash da linha fazia parte da identidade, mudando com cotação/ordem de colunas. | `latestProcessedReport` ordena por geração/ID oficial; `planStatementImport` reutiliza observações equivalentes, preserva multiplicidade e produz identidade de evento independente do valor/aspas. `financial_import_runs.summary.accounts[].sources[].selectedReport/selectedEntryIds` registra a composição da fotografia escolhida, inclusive linhas reutilizadas. |
| Líquido da venda | B/A | Pedido ML fornece `sale_fee` e frete, mas não todas as cobranças direcionadas ao collector. | `captureSaleFinance` consulta detalhes MP na mesma execução de `processMercadoLivreOrder`, com timeout de 8s, lotes de até 3 e limite de 20 pagamentos. Calcula em centavos a origem comercial a partir das cobranças originais direcionadas; compara com líquido MP quando approved. Guarda estado, cobranças, valores observados, data de coleta e limitações em `venda.raw_data.financial_capture`. `registerMarketplaceSale` usa líquido corrigido somente quando comprovado, preservando observação válida em falha posterior. |
| Datas nulas | C | `registerMarketplaceSale` só projetava `soldAt`. Aprovação existe no payload do pedido e também pode existir no MP. | `data_pagamento` recebe a primeira aprovação documentada, não conclusão de todas as parcelas. Previsões e status permanecem por pagamento no JSON. Não preencher `data_liberacao` com previsão. Ausência de comprovação é limitação da fonte escolhida. |
| Claims de envio | B/C | `normalizeCase` só projetava pedido se `resource=order`. | O bundle resolve `/shipments/{id}/items`, valida `sender_id` de todos os itens, guarda relação plural e só projeta `order_id` quando unívoco. O RPC existente vincula `venda_id` por conta/pedido. Relação plural fica documentada em `marketplace_cases.content.order_relation`, sem escolha arbitrária. |
| `partial` fixo e falha auxiliar derrubando tudo | A/C | O normalizador atribuía partial a qualquer detalhe; `Promise.all` rejeitava o bundle por um único erro auxiliar. | Recursos auxiliares são isolados; `enrichment.resources` registra endpoint, obtenção ou erro sanitizado/status HTTP quando fornecido pelo cliente. Dados válidos persistem pela observação/RPC existente. Complete significa recursos desta captura obtidos, não certificação financeira universal. Raiz inválida ainda falha. |
| Custos de devolução | B/C | Consulta existente para ação explícita usa cache transitório; bundle do worker não persistia o custo. | O bundle do worker, nos gatilhos existentes, pode obter `charges/return-cost`. Guarda `content.return_cost` (amount/currency/claim/endpoint/coleta/contexto). Não altera refund bruto nem cria débito; valores já pertencem ao extrato. Leitura de página e preparação de ação não ganham essa consulta financeira adicional. |
| Identidades diversas | B/C | IDs de envios, pagamentos e pedidos MP eram confundidos com pedidos ML. | Venda financeira exige collector, moeda e pedido ML correspondentes. Pagamentos de envio/transferência não viram vendas fictícias. Claims de envio têm associação tipada. O enriquecimento financeiro geral do futuro importador não foi desenvolvido; não há mecanismo novo para atualizar vendas posteriormente. |

## Caso obrigatório e estados financeiros

O caso 2000018731626134 / 181743041608 / SKU 1405PPD tem R$29,00 de produto, R$25,99 de frete e R$3,77 nas taxas do pedido: fórmula anterior R$51,22. O detalhe MP adiciona R$36,20 de `shp_cross_docking`; a fórmula em centavos resulta R$15,02. O teste reproduz os valores com identidades sintéticas. A venda histórica não foi alterada.

Os 67 casos foram revisados em memória usando snapshots já persistidos: 66 incluem `shp_cross_docking`, 12 têm refund e 6 cobranças de entrada (grupos sobrepostos). Não se aplica uma dedução universal. Uma fotografia posterior a refund/disputa não comprova o líquido comercial original: nesse caso, guarda-se contexto e preserva-se o último líquido comercial comprovado, ou mantém-se a estimativa explicitamente incompleta. O custo de retorno não é descontado novamente da venda. Snapshot financeiro atual e faturamento são conceitos separados; o extrato permanece fonte exclusiva de movimentação. A tela de Vendas passa a distinguir líquido comercial estimado/capturado e deixa explícito que não é prova de movimento.

`complete` descreve a observação disponível naquele processamento. Cobranças podem surgir depois; nenhum novo poll/retry/scheduler foi criado. Outro gatilho existente poderá atualizar naturalmente. Falha, propriedade divergente, campo ausente ou fórmula não corroborada mantém `partial`; não fabrica zero. Um sucesso anterior fica como última observação válida, sem cadeia de históricos crescente.

## Validação real somente leitura

`scripts/audit-financial-source-integrity.mjs` só faz SELECT: nenhuma tentativa de INSERT, nem mesmo para testar RLS. Corpos oficiais ficam em memória. Resultado em 27/10/2026:

- 239 linhas: 98 ED + 141 GI; 6 hashes de resposta conferidos, 2 arquivos distintos.
- 239 valores/sinais/datas originais preservados.
- 70 diferenças textuais históricas, exclusivamente METADATA/OPERATION_TAGS; 163 campos JSON interpretados validamente.
- 67 casos revisados por tipo de cobrança e estado. Relatório detalhado está nos entregáveis desta tarefa.

Não foram incorporados dados de produção aos fixtures do repositório. A revisão automática bloqueou tanto os arquivos brutos quanto a variante que mantinha valores/datas reais com IDs anonimizados; a alternativa adotada é teste sintético e verificação real apenas em memória.

O Smart Check encontrou também uma incompatibilidade anterior em `verify-financial-october-2026.mjs`: uso de chave anônima e tentativa remota de INSERT para testar RLS. Esse verificador agora é estritamente SELECT-only; testes de permissões devem ocorrer em banco isolado. Ele reporta separadamente diferenças textuais de collector v1, exige igualdade de todos os demais campos e continua estrito para collector v2. Nenhuma permissão de produção foi alterada.

## Idempotência e uso futuro da fotografia

Mesma linha histórica não é regravada para corrigir seus textos. CSV regenerado com a mesma projeção é reutilizado. Mudança real gera nova observação imutável; não é um segundo movimento econômico. Usar a composição explícita `selectedEntryIds` de uma execução/fonte completa através de `selectStatementSnapshot`, jamais somar todas as versões da tabela. Uma linha ausente na foto selecionada não é herdada automaticamente da anterior. Coberturas sobrepostas exigem escolher uma janela/foto, não concatenar janelas.

O helper de fotografia não é uma implementação do menu/rotina de conciliação. A conciliação posterior continuará lendo somente o banco. O coletor permanece CLI manual de outubro/2026; não foi generalizado nem executado com escrita. A configuração remota ED `include_withdraw=false` não foi modificada. Geração de arquivo/configuração/reimportação continuará exigindo autorização específica.

## Testes e publicação controlada

Testes novos: `financial-source-integrity.test.mjs`, `mercado-livre-sale-finance.test.ts`, `inventory-sale-financial-persistence.test.ts`, `marketplace-case-financial-capture.test.ts`. Cobrem dialetos/IDs/valores, referência sintética 239/70, repetição/regeneração/multiplicidade, captura e persistência real de venda em banco simulado, aprovação vs previsão, falhas/identidade, financiamento, claims plurais, persistência do custo via RPC existente, ausência de timers ou chamadas em abertura de páginas e ausência de varredura histórica.

Executar TypeScript e Smart Check; após commit, `deploy:smart -- --dry-run` apenas inspeciona o plano e não publica. Os resultados finais e hash do commit acompanham o relatório de entrega.

Impacta Vercel: sim (bibliotecas compartilhadas e apresentação de Vendas). Impacta worker VPS: sim (captura nos gatilhos de pedidos/reclamações). Supabase: somente chaves JSON e colunas existentes, sem migration. Dependências: sem alteração; não requer npm ci por mudança de dependência.

Para uma publicação futura aprovada, validar o plano cumulativo, publicar o commit e fazer deploy Vercel; na VPS executar git pull origin main, reiniciar marketplace-worker com --update-env e verificar pm2 status. Isso não foi executado. Não declarar READY. O baseline local confirmado anterior continua soberano; o plano cumulativo inclui os commits de importação já existentes.

## Pendências e limitações deliberadas

- Disponibilidade efetiva não é comprovada por MONEY_RELEASE_DATE/status observado; `release_report` foi definitivamente retirado do escopo.
- Competência/documentação externa TMLOGISTICA continua pendente; não existe captura comprovada de fatura externa neste fluxo.
- Quando endpoint não expõe o dado ainda, ele fica pendente até gatilho existente natural. Não há consulta futura exclusiva para preenchê-lo.
- Falhas auxiliares não permitem inventar prova de cobrança; custo de retorno não fornece charge_id, então não certifica sozinho identidade da linha do extrato.
- Lançamentos Futuros não foi implementado: preservam-se mês corrente/seguinte, foto corrente sem histórico, última sincronização de status e atualização explícita apenas em Atualizar extrato.
- Regras gerenciais do extrato não foram alteradas: rendimentos separados, CASHBACK/PAYOUTS fora da operação salvo TMLOGISTICA, financiamento equivalente anulado e reversões agrupadas sem dupla dedução.
