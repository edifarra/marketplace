# Auditoria de devolução ML — 11/10/2026

## Evidências anteriores à alteração

Caso 5591866489 / ML-ED: existe atividade 357656df-5a8c-487a-aa29-1e3900c8bb23, allow_return, criada em 11/10/2026 00:10:57 UTC (10/10 21:10:57 Brasília). Histórico claim_queued seguido de claim_pending/error, remote_execution_state=rejected. Não chegou à barreira de envio nem ao POST. Motivo: "O pedido ou a reclamação mudou após a confirmação".

A revisão oficial permanece 2026-10-10T15:35:59.000-04:00. Produtos oficiais retornam propriedades title,quantity,amount; o contexto persistido em JSONB retorna amount,title,quantity. O worker comparava JSON.stringify: diferença de ordem provocava falsa mudança. Corrigido com stableClaimValue, já utilizado no domínio. Mudanças reais de valores, produtos, revisão, identidade e ações continuam bloqueadas.

Clique -> GET actions -> prepareClaimAction -> bundle oficial e validação -> modal assinado. Confirmar -> POST actions -> queueClaimOperation -> RPC enqueue_marketplace_claim_operation -> outgoing_marketplace_activities + history -> worker executeMarketplaceClaimActivity -> executeClaimOperation -> revalidação -> begin_marketplace_claim_send -> POST oficial -> confirmação por GET -> persistência/status. Resultado incerto continua sendo reconciliado sem repetir POST.

A mensagem genérica informada também pode ter vindo de outro GET anterior ao modal; sem o log daquela requisição não se comprova a causa dessa tentativa específica. A rejeição operacional acima está comprovada. Logs novos distinguem prepare/enqueue e preservam o erro técnico com remoção de Bearer/JWT.

Atividades Enviadas consulta todas as categorias, sem excluir claim_action. SKU da operação é o número do claim; filtro pelo SKU do produto não encontra esse registro. Filtro de tipo e rótulo de reclamação adicionados; campo de busca esclarecido. Resultado incerto passa a ter status explícito. Filtros/paginação efetivamente utilizados pelo usuário não estão disponíveis, portanto não se afirma uma causa única da ausência visual.

## Consultas reais somente leitura

Com token armazenado da conta correspondente, sem renovação: os dois bundles e return-cost retornaram HTTP 200 antes da devolução, enquanto allow_return estava disponível.
- 5591866489 / ML-ED: {currency_id: BRL, amount: 0}.
- 5592119231 / ML-GI: {currency_id: BRL, amount: 10.99}.

Script reproduzível: node --env-file=.env.local --require ./scripts/register-server-only.cjs --import tsx scripts/audit-claim-return.ts. Bloqueia métodos diferentes de GET/HEAD; não imprime tokens ou dados fiscais.

Documentação oficial consultada: https://developers.mercadolivre.com.br/pt_br/relatorios-de-faturamento/gerenciar-devolucoes confirma GET charges/return-cost e amount como cobrança ao vendedor. Contrato POST expected-resolutions/allow-return preservado. Não foi confirmada regra universal de sete dias úteis, por isso o modal remete ao prazo informado pelo Mercado Livre. Consultas em outros estágios não foram realizadas: não se alterou o estado dos casos para teste.

## Implementação e impacto

Consulta sob demanda no detalhe expandido com allow_return; não entra na listagem nem reconciliação. Reutiliza CaseReadCache, TTL 15 minutos, memória limitada, cache por conta/caso/updated_at e deduplicação. Cache em memória por processo, portanto instâncias diferentes da Vercel podem fazer leituras separadas. Falhas não são cacheadas. Preparação do modal revalida custo; indisponibilidade nunca vira gratuidade. Uma leitura adicional por detalhe sem cache e uma por abertura do modal. Nenhuma consulta de custo no worker. Nenhuma tabela, migration, retenção ou frequência alterada.

Testes com mocks para custos, autorização, indisponibilidade, resposta inválida, cache, TTL, deduplicação, ausência de capability, preparação somente leitura, sucesso/falha de fila, comparação JSONB, worker, repetição/concor­rência e resultado incerto. Nenhuma devolução/reembolso real executada.

Produção pendente por restrição explícita da tarefa: não executar deploy/migration sem autorização. Impacta Vercel e worker VPS; exige pull e reinício PM2 após publicação autorizada. Sem mudanças de dependências, npm ci não necessário. Nenhuma atividade histórica foi reprocessada.
