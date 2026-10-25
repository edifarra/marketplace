# Importação financeira manual — outubro de 2026

Implementação no projeto `edifarra/marketplace`, Supabase `ukfefrdaivqzxeeknmqr`.
Janela final: 01/10/2026 00:00 até 25/10/2026 19:51:24, America/Sao_Paulo; limite final exclusivo (`2026-10-01T03:00:00Z` a `2026-10-25T22:51:24Z`). Os instantes de cada coleta e o período de cada execução ficam no banco. Relatórios são fotografias no instante em que o provedor os gerou, não uma garantia de atualização instantânea.

## O que foi criado

- Migration `supabase/migrations/20261025203356_financial_statement_import.sql`, aplicada no Supabase e com a versão real do histórico remoto.
- `financial_import_runs`: janela, versão do coletor, estado e resultado por conta/fonte.
- `financial_api_responses`: bytes integrais recebidos em base64, SHA-256, endpoint, parâmetros sem credenciais, status HTTP, cabeçalhos selecionados e instante da coleta. Inclui respostas de erro e metadados. Não possui expiração programada.
- `financial_statement_entries`: conta, fonte, semântica, ID externo, data e base temporal, moeda e sua origem/ausência, valor e sinal explícitos, componentes monetários, payload completo, linha CSV original, hash e vínculo à resposta original.
- Importador CLI manual, verificador de integridade, cinco testes de regressão e teste SQL de RLS.

Uma estrutura comum de evidências e observações foi escolhida em vez de tabelas por marketplace: os campos completos permanecem no payload e nos bytes originais, enquanto os campos comuns permitem pesquisa. Não há redução a uma fórmula financeira universal. Todas as observações mantêm conta/fonte/semântica distintas.

RLS habilitado e forçado nas três tabelas; sem políticas de acesso a clientes. `PUBLIC`, `anon` e `authenticated` não têm privilégios. `service_role` só tem SELECT/INSERT nas respostas e lançamentos; não tem UPDATE/DELETE. Nas execuções, somente status, resumo e término podem ser atualizados. Nenhuma função SECURITY DEFINER foi criada. O advisor sinaliza INFO de RLS sem políticas, intencional neste modelo exclusivo de backend; não foi aberto acesso para eliminar esse aviso. Avisos de search_path de funções antigas são preexistentes e não foram alterados.

## Resultado persistido

Conferência de dados ao concluir a coleta: **502 observações**, das quais **239 linhas de extrato Mercado Pago**, **130 fotografias de pagamentos**, **45 movimentos de carteira Shopee**, **44 liberações de escrow** e **44 detalhes de escrow**. As categorias se sobrepõem financeiramente e não devem ser somadas como receita.

| Conta | Fonte / semântica | Registros | Soma do valor da fonte |
|---|---|---:|---:|
| ML-ED | Extrato / eventos financeiros | 98 | 3.925,99 |
| ML-ED | Pagamentos / recebedor | 55 | 6.565,85 |
| ML-GI | Extrato / eventos financeiros | 141 | 10,11 |
| ML-GI | Pagamentos / recebedor | 61 | 6.129,36 |
| ML-GI | Pagamentos / pagador | 14 | 1.643,79 |
| SP-ED | Carteira | 27 | -119,73 |
| SP-ED | Liberações de escrow | 27 | 1.500,27 |
| SP-ED | Detalhes de escrow | 27 | 1.500,27 |
| SP-GI | Carteira | 18 | -145,90 |
| SP-GI | Liberações de escrow | 17 | 665,20 |
| SP-GI | Detalhes de escrow | 17 | 535,16 |

As somas de pagamentos incluem estados diversos, inclusive rejeições, e não representam dinheiro recebido. Fotografias de pagamento e detalhes de escrow ficam com `signed_amount=NULL`: não são novos movimentos de caixa. Na carteira o sinal segue `money_flow`; nas liberações e no extrato preserva o sinal do valor retornado.

Moeda BRL veio nos pagamentos e nas linhas do relatório ML-GI. O CSV ML-ED não inclui coluna de moeda na configuração existente (a lista de relatórios informa BRL); as respostas Shopee consultadas não informam moeda nas linhas. Nesses casos a coluna normalizada fica NULL com justificativa explícita, sem inventar um campo que não veio da fonte. Os metadados completos continuam disponíveis nas respostas.

### Abrangência temporal dos registros (São Paulo)

| Conta/fonte | Primeiro | Último |
|---|---|---|
| ML-ED extrato | 01/10 00:09:43 | 24/10 20:42:00 |
| ML-ED pagamentos | 01/10 00:09:35 | 24/10 19:46:00 |
| ML-GI extrato | 01/10 01:45:53 | 25/10 08:22:03 |
| ML-GI pagamentos (recebedor) | 01/10 05:37:17 | 25/10 08:20:22 |
| ML-GI pagamentos (pagador) | 01/10 16:59:22 | 24/10 12:04:47 |
| SP-ED carteira/escrow | 01/10 11:16:50 | 23/10 09:23:55 |
| SP-GI carteira | 02/10 11:30:12 | 22/10 10:15:31 |
| SP-GI escrow | 02/10 11:30:12 | 22/10 10:05:57 |

Todos os `occurred_at` persistidos estão em outubro e dentro da janela de sua execução. Datas de compras de setembro ou liberações futuras podem existir dentro dos documentos originais de um movimento de outubro; elas não são lançamentos adicionais desses outros meses.

Para Mercado Pago, o evento usa `SETTLEMENT_DATE`; `TRANSACTION_DATE` continua integralmente preservada como data da operação original. Foram incluídos 14 eventos de outubro que se referem a operações antigas. Durante a validação inicial, a projeção temporal das 225 primeiras linhas foi corrigida na própria tabela nova, antes da entrega; o payload e a linha original não foram alterados. Nenhuma tabela de negócio preexistente foi modificada.

## Fontes oficiais e limites reais

Mercado Pago: [API de relatórios](https://www.mercadopago.com.br/developers/pt/reference/reports/overview), [geração manual](https://www.mercadopago.com.br/developers/pt/reference/settlements-report/create-report/post), [configuração e include_withdraw](https://www.mercadopago.com.br/developers/pt/docs/reports/account-money/api), [glossário](https://www.mercadopago.com.br/developers/pt/docs/reports/account-money/report-fields). Relatório de dinheiro em conta é diferente de `/v1/payments/search`; a segunda fonte é apenas complementar. A API arredondou o fim dos relatórios solicitados para `2026-10-26T02:59:59Z`; o importador aplica o corte local pelo evento financeiro.

**Limite ML-ED:** a configuração existente retornou `include_withdraw=false`. As 98 linhas retornadas foram importadas, mas não é possível declarar um extrato completo incluindo saques. A configuração existente não foi modificada. A coleta final permanece `partial` por esse motivo. Para incluir os saques, será necessário autorizar a mudança dessa configuração no Mercado Pago e gerar outro relatório; não basta repetir o download atual.

Tarefas manuais geradas: ML-ED `103766936`; ML-GI `103766943` e `103766947`. A repetição ML-GI ocorreu enquanto a normalização do período retornado era validada. Os arquivos usados foram `settlement-report-187049698-manual-2026-10-25-184501.csv` e `settlement-181345701-manual-2026-10-25-184626.csv`. Não foi ativado agendamento; configurações consultadas retornaram `scheduled=false`.

Shopee: referências oficiais tentadas [wallet transaction list](https://open.shopee.com/documents/v2/v2.payment.get_wallet_transaction_list?module=97&type=1), [escrow list](https://open.shopee.com/documents/v2/v2.payment.get_escrow_list?module=97&type=1), [escrow detail](https://open.shopee.com/documents/v2/v2.payment.get_escrow_detail?module=97&type=1). O portal retornou HTTP 403 ao mecanismo de documentação. Não se afirma validação integral do contrato documental ou da matriz regional de permissões. As respostas das três APIs oficiais foram comprovadas diretamente em SP-ED e SP-GI e armazenadas sem perda. A carteira foi coletada separadamente; `get_escrow_detail` por pedido não foi tratado como extrato da conta nem como transferência bancária.

Os detalhes de escrow foram obtidos para todos os 44 pedidos presentes nas listas de liberações da janela. Não representam uma varredura de todos os pedidos pendentes ou criados em outubro. Diferenças entre detalhe e liberação (por exemplo SP-GI 535,16 vs 665,20) são insumo para futura conciliação, não foram corrigidas ou presumidas como erro.

Falhas transitórias observadas: timeout de API, falha de rede Supabase, token inválido durante rotação e indisponibilidade temporária de uma requisição MCP. Houve retomada idempotente e preservação dos erros recebidos. O importador relê token já atualizado pelo fluxo existente quando necessário; não renova nem grava credenciais. Os estados parciais anteriores permanecem como trilha de auditoria.

## Validação

- Cinco testes: IDs longos/decimais sem arredondamento, fronteiras de fuso e mês, evento de outubro de compra antiga, sinais, CSV com aspas e quebras de linha.
- Todas as observações comparadas com o payload reconstruído dos bytes originais; linhas CSV comparadas literalmente. Hash de cada resposta conferido.
- Todos os 45 IDs longos da carteira preservados como texto exato; tipos numéricos originais continuam nos bytes integrais da resposta.
- Zero duplicidades pela chave `(account_id,source,semantic,external_id,payload_sha256)`. Cada lote foi reinserido com retorno de zero novos registros; a coleta final repetiu as quatro contas.
- RLS testado em transação com permissões temporárias para `anon` e `authenticated`; SELECT revelou zero linhas e INSERT foi bloqueado. Tudo revertido ao final. Teste em `scripts/verify-financial-rls.sql`.
- REST com chave anônima: SELECT e INSERT negados nas três tabelas, código `42501`.
- Índices para conta/fonte/data, IDs externos, execução e referências de evidência. Respostas repetidas são preservadas como novas coletas; não são duplicidades de lançamentos.
- `npm run typecheck` passou. `check:smart` e dry-run devem ser executados depois do commit, conforme AGENTS.md; saídas da entrega acompanham o relatório final.

As observações são versionadas por conteúdo. Uma mudança real no retorno do provedor gera nova versão, nunca sobrescreve a anterior. Para conciliação futura é preciso escolher a observação adequada por identidade e data de coleta, evitando somar versões ou fontes sobrepostas. Não há política automática de limpeza.

## Execução manual e finalização

Requer Node 24, dependências já instaladas, `.env.local` com URL, service role e chave anônima, além das credenciais das contas já cadastradas. Não colocar service role no navegador. Rodar na raiz do repositório:

```powershell
node scripts/import-financial-october-2026.mjs --dry-run --end=2026-10-25T22:51:24.000Z --report=tmp/financial-dry-run.json
node scripts/import-financial-october-2026.mjs --write --replay-check --end=2026-10-25T22:51:24.000Z --report=tmp/financial-import.json
node scripts/verify-financial-october-2026.mjs --report=tmp/financial-verification.json
node --test tests/financial-import.test.mjs
npm run check:smart
npm run deploy:smart -- --dry-run
```

`--accounts=ML-ED,ML-GI` restringe a retomada. Se não houver relatório pronto, `--write --generate-reports` solicita geração manual, criando configuração somente se ausente; nunca ativa cron ou agendamento e nunca altera uma configuração existente. Depois de pronto, repetir com o mesmo `--end` sem essa opção. Dry-run consulta APIs mas não grava evidências, lançamentos ou configurações.

Migration já aplicada: **não reaplicar manualmente**. Em outro ambiente vazio, aplicar a migration versionada primeiro com o fluxo Supabase autorizado. Nenhum deploy, push, `git pull` ou reinício de processo é necessário para utilizar o importador local. Publicação do código e qualquer deploy permanecem fora do escopo autorizado.

Impacta Vercel? **Não.** Impacta worker da VPS? **Não.** Precisa `git pull` na VPS? **Não.** Precisa `npm ci`? **Não.** Precisa `pm2 restart marketplace-worker --update-env`? **Não.** Não houve alteração de menu, vendas, fórmulas, logística ou dados operacionais existentes. O código será registrado por `commit:smart`; hash e arquivos exatos constam na entrega.
