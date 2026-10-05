# Central de Reclamações e Devoluções — Etapa 1

Implementação local para revisão. Nenhuma tela, ação executável, nova fila, polling ou mudança em Chats e Perguntas.
Sem commit, publicação, migration remota, atualização de VPS ou PM2.

## Arquitetura e banco

Migration: `supabase/migrations/20261005003405_marketplace_cases_stage_one.sql`, criada pela CLI Supabase.

| Tabela nova | Conteúdo |
| --- | --- |
| `marketplace_cases` | Identidade única `(marketplace, marketplace_account_id, external_case_id, case_type)`; `venda_id`, `order_id`, `conversation_id`, `venda_item_id`, `product_id`, `listing_id`; `status`, `stage`, `responsible`, `needs_action` nullable, `reputation_impact` tri-state, `resolution`, `official_updated_at`; `content`, `reverse_logistics`, `enrichment`; timestamps de controle. |
| `marketplace_case_observations` | Fonte, chave idempotente, timestamp oficial, observação, ordenação de recebimento, estado e snapshot sanitizado do Caso. Sem envelope bruto nem credenciais. |
| `marketplace_case_timeline` | Transições de estado de negócio, incluindo logística reversa e resolução; ator conhecido ou `unknown`, fonte, timestamp oficial e observação; chave única por Caso/transição. |
| `marketplace_case_deadlines` | Vários prazos por observação: finalidade, responsável, valor, precisão, timezone, origem, validade e metadados com campo oficial/valor original. |
| `marketplace_case_actions` | Snapshots históricos de código, obrigatoriedade, prazo, capacidades/parâmetros e momento de observação. |
| `marketplace_case_evidence` | Referências de imagem, vídeo ou anexo e metadados; sem download e sem mensagens do Chat. Imagens explicitamente presentes no detalhe de Return são mapeadas. |
| `marketplace_case_rollout` | Marco de recebimento para permitir enriquecimento somente de eventos novos. Uma linha criada no momento da migration. |

`content` contém `reason_code`, `reason`, `buyer_description`, `affected_quantity`, `refund_amount`, `currency` e `capabilities_known`.
`reverse_logistics` suporta status, modalidade, tracking e endereço. O mapeamento inicial preenche apenas o status comprovado; não reutiliza envio/endereço original.
`enrichment` registra estado incompleto/parcial/erro, origem, obtenção e erro sanitizado quando aplicável. Um detalhe obtido não é declarado completo quando há informações sem contrato comprovado.

RPC nova: `persist_marketplace_case(jsonb) → uuid`, `SECURITY INVOKER`, transacional, com bloqueio da linha do Caso e conflitos únicos.
Todas as tabelas têm RLS; permissões apenas para `service_role`. A função não pode ser executada por `PUBLIC`, `anon` ou `authenticated`.
Não houve alteração nas tabelas existentes de filas, atividades, conversas ou vendas.

## Consolidação inicial exclusivamente local

`consolidateLocalCases` lê páginas de até 250 atividades `post_purchase`/`29`, anteriores ao marco da migration, com paginação por recebimento e ID.
Extrai Claim ID e `return_sn` dos envelopes persistidos, resolve a conta exclusivamente por seller/shop local e grava via RPC.
Também lê vendas ML e os IDs de `raw_data.payload.order.mediations`, quando há conta persistida válida. Esse caminho consolida identidade/vínculo, sem inventar o estado ou apagar um detalhe conhecido.

Eventos sem conta inequívoca são contabilizados em `unknownAccount` e não atribuídos a outra loja. Eventos sem identificador de Caso não viram Casos.
A rotina não reprocessa pedidos, estoque, filas ou atividades técnicas; não altera seu status. Não importa resultados dos GETs de auditoria.
Pode ser retomada/reexecutada. As contagens indicam observações visitadas/consolidadas, não necessariamente novos Casos.

Após revisão e aplicação autorizada da migration, o comando manual é:

```powershell
node --env-file=.env.local --import tsx scripts/consolidate-local-marketplace-cases.ts
```

Esse comando **não foi executado contra o banco configurado** nesta entrega. A consolidação foi exercitada com banco simulado, com chamadas externas proibidas no teste.

## Novos eventos e retry

ML: `post_purchase` com Claim identificável deixa a confirmação genérica. O worker resolve a conta explícita do evento, persiste primeiro o Caso local e, somente se o recebimento for posterior ao marco da migration, consulta `/post-purchase/v1/claims/{id}` pelo cliente autenticado existente. A identidade retornada precisa coincidir com a notificação.
Estado, etapa, resolução e ações oficiais do vendedor são mapeados. `mandatory=true` sustenta necessidade de ação; abertura sozinha nunca a sustenta.
Prazos das ações são independentes; o instante oficial é preservado em UTC e o valor original fica nos metadados do prazo.

Shopee: push 29 com `return_sn` persiste o Caso antes de processar pedidos. Eventos novos podem consultar `/api/v2/returns/get_return_detail`, usando assinatura/renovação de token existentes e validando o `return_sn` retornado.
O processamento original de todos os pedidos identificados continua, mesmo se o detalhe falhar. Uma falha de estoque não impede a gravação do Caso.
Todos reutilizam o ID da atividade existente. A opção `deferActivityCompletion` mantém a conclusão no worker, depois de Caso e pedidos terem sucesso; não cria uma segunda fila/atividade para esse fluxo.
Uma gravação idempotente final atualiza o vínculo local da venda que tenha sido criada durante o processamento.

Se o detalhe falhar, Caso e observação local permanecem; registra-se `case_enrichment_failed` e histórico `case_enrichment/retry`, sem guardar a exceção bruta que poderia conter credenciais.
O erro chega ao mecanismo existente: até cinco tentativas, espera exponencial limitada a 30 minutos e estado terminal `error` quando esgotado. Não existe retry paralelo.
Se o detalhe já foi persistido e o processamento de pedido falhar, o retry não consulta novamente aquele detalhe.
Atividades antigas ainda pendentes/reprocessadas fazem apenas manutenção local de Caso: o marco de recebimento impede enriquecimento histórico.

## Idempotência, vínculo e retenção

- Identidade do Caso não usa pedido/venda: dois retornos do mesmo pedido produzem dois Casos.
- Observações únicas por Caso/chave (`activity_id:local`, `activity_id:detail` ou identidade local de mediação).
- Bloqueio do Caso serializa gravações concorrentes; Caso, timeline e snapshots filhos são uma transação.
- Estado atual respeita ordenação de recebimento e rejeita regressão quando há timestamps oficiais comparáveis.
- Estados consecutivos iguais não criam nova etapa visual. Transições com timestamp oficial têm chave baseada em estado+timestamp; sem timestamp oficial, usam a chave estável da observação. Não é possível provar equivalência histórica além dos dados disponíveis.
- Conversa exige marketplace, conta e pedido exatos, tipo Chat/pós-venda e um único resultado. Comprador, SKU e produto não participam da associação. Ambiguidade permanece sem vínculo.
- Venda exige pedido/marketplace e conta persistida coincidentes. IDs de produto/item/anúncio permanecem nulos sem relação segura.
- A retenção existente permanece: atividades 60 dias; conversas três meses. Não há FK do Caso/timeline para atividades/histórico técnico. A exclusão da conversa usa `SET NULL`. A conta usa `RESTRICT`. Cascades ficam dentro da persistência própria do Caso.
- Ações são snapshots para uma interface futura, sem autorização automática de execução. Uma implementação futura deve revalidar estado e capacidade antes de agir.

## Unknowns intencionais

Responsável sem indicação confiável; necessidade de ação sem capacidades oficiais suficientes; finalidade Shopee `due_date`; reputação Shopee sempre `unknown`.
ML reputação também fica `unknown` sem valor oficial persistido: não se consulta o recurso separado de reputação nesta implementação mínima.
Modalidade/tracking/endereço reversos, dados de produto/item sem vínculo comprovado, ações Shopee e parâmetros sem contrato confirmado, referências de vídeo/anexo que não estejam mapeadas com segurança.
O esquema suporta essas informações sem atribuir valores ou significados presumidos. Ausência de capacidades conhecidas é diferenciada de uma lista oficial vazia.

Contrato ML consultado apenas como documentação pública: [Gerenciar reclamações](https://developers.mercadolivre.com.br/pt_br/produto-consulta-de-usuarios/gerenciar-reclamacoes). Nenhuma consulta autenticada a marketplace foi executada para desenvolver ou consolidar histórico.

## Validação local

- `npm run typecheck`: passou.
- `npm run build`: passou, com avisos existentes de imagens em componentes não alterados.
- Suíte TypeScript: 59 testes passaram, incluindo 16 novos de Casos e regressões existentes de reconciliação/conversas Shopee e reativação de estoque.
- SQL: 7 testes passaram executando a migration em PostgreSQL isolado via PGlite instalado apenas em diretório temporário. Cobrem unicidade ML/Shopee, dois retornos no mesmo pedido, replay, timeline, eventos antigos, identidade local sem apagar enriquecimento, vínculo tardio de venda, atomicidade dos filhos, retenção e permissões.
- Os doze cenários solicitados são cobertos pela combinação dos testes de domínio/orquestração e SQL. Falhas de Caso/pedido são exercitadas independentemente.
- Não foi feita validação autenticada ponta a ponta com ML/Shopee nem com o Supabase remoto. Isso permanece para uma implantação futura autorizada.

Comandos reproduzíveis:

```powershell
./node_modules/.bin/tsx.cmd --require ./scripts/register-server-only.cjs --test tests/marketplace-cases.test.ts tests/shopee-conversation-reconciliation.test.ts tests/shopee-message-classification.test.ts tests/shopee-message-product-cards.test.ts tests/marketplace-stock-reactivation.test.ts
npm install --prefix "$env:TEMP\marketplace-case-sql-test" --cache "$env:TEMP\marketplace-case-npm-cache" --no-package-lock --no-audit --no-fund @electric-sql/pglite
$env:PGLITE_MODULE = "$env:TEMP\marketplace-case-sql-test\node_modules\@electric-sql\pglite\dist\index.js"
node --test tests/marketplace-cases-sql.test.mjs
```

## Arquivos

Novos: `lib/marketplace-case-domain.ts`, `lib/marketplace-cases.ts`, `lib/marketplace-case-enrichment.ts`, `scripts/consolidate-local-marketplace-cases.ts`, a migration acima, `tests/marketplace-cases.test.ts`, `tests/marketplace-cases-sql.test.mjs`, este relatório.
Alterados: `lib/marketplace-queue-worker.ts`, `lib/inventory.ts`, `lib/shopee-orders.ts`, `lib/marketplaces/shopee/client.ts`.
`package.json` e `package-lock.json` não mudaram.

## Impacto de implantação futura — nenhuma execução nesta entrega

Impacta Vercel? **Sim**. Impacta o worker da VPS? **Sim**.
Precisa `git pull` na VPS? **Sim, após aprovação/publicação futura**.
Precisa `npm ci`? **Não**.
Precisa `pm2 restart marketplace-worker --update-env`? **Sim, após aprovação/publicação futura**.
Hash do commit: **não existe; commit proibido neste pedido até sua revisão**.
Produção não foi alterada; não há deploy `READY` a informar.

Somente após revisão, commit/publicação e autorização futura de implantação, a atualização da VPS seguirá o fluxo sem alteração de dependências:

```bash
cd /opt/gestao-marketplace
git pull origin main
pm2 restart marketplace-worker --update-env
pm2 status marketplace-worker
```

Nenhuma API foi usada para backfill. Nenhuma migration remota, Vercel, VPS ou PM2 foi executada.
