# Central: cache de leitura e reconciliação horária

Implementação exclusivamente local, baseada em `9e8a6d106f58ff3c6ac035b707939eb5c3ab8fee`. Nenhum deploy, acesso financeiro, reconciliação em massa, migration remota ou comando na VPS foi executado nesta tarefa.

## A. Abertura e drilldown

Fluxo anterior: página dinâmica → `loadCaseList`; expansão/montagem/foco → GET `/api/central-reclamacoes/[id]` → `loadCaseDetail`. Não havia sincronização externa nesse caminho, mas fechar e reabrir repetia a leitura completa. A rota direta fazia uma leitura de identidade no servidor e depois carregava os detalhes no cliente.

Fluxo novo: listagem e detalhes usam `CaseReadCache`, com validade fixa de 900.000 ms, somente após sucesso, limite de memória e deduplicação de promessas concorrentes. A listagem mantém os filtros como parte da chave. O cliente guarda os detalhes em memória e `sessionStorage`, por aba, com até 40 entradas persistidas; não usa `localStorage` compartilhado. A rota direta entrega os detalhes já lidos no servidor, evitando outro GET de detalhes na hidratação. A listagem já fornece identificação, conta, produto e revisão para o cabeçalho e a partição do cache. Campos adicionais ainda são carregados pelo leitor consolidado existente.

Chave: usuário + versão de sessão + perfil de autorização + marketplace + conta + UUID do caso + revisão do caso. O servidor resolve a identidade antes de escolher a partição; autenticação e controles existentes são preservados. O cache nunca é usado para autorizar uma operação.

Métricas abaixo são de **fixtures locais executando os leitores reais**, não de tráfego medido em produção. Detalhe ML com venda/SKU/conversa/snapshot: 10 leituras; Shopee equivalente sem recuperação de atividades antigas: 9; listagem sem busca com uma página visível, snapshot e SKU: 10. Paginação de filhos, muitos SKUs, busca e recuperação de marcos antigos podem aumentar esses números.

| Operação | Antes: HTTP próprio / leituras de negócio | Depois: HTTP próprio / leituras de negócio |
|---|---|---|
| Abrir Central, cache frio | 1 página ou navegação RSC / 10 | 1 página ou navegação RSC / 10 |
| Retornar à mesma listagem, cache válido no mesmo processo | 1 página ou navegação RSC / 10 | 1 página ou navegação RSC / 0 |
| Abrir caso pela primeira vez | 1 GET / ML 10, Shopee 9 | 1 GET / ML 10, Shopee 9 |
| Reabrir caso em menos de 15 min | 1 GET / ML 10, Shopee 9 | 0 GET / 0 |
| Reabrir após expiração dos caches | 1 GET / ML 10, Shopee 9 | 1 GET consolidado / ML 10, Shopee 9 |
| Expandir Gerais, Timeline ou evidência já carregada | 0 / 0 | 0 / 0 |

Em todas essas operações: **0 escritas Supabase, 0 chamadas ML/Shopee, 0 enfileiramentos**. Fotos/vídeos podem fazer GETs ao servidor de mídia, inclusive solicitações parciais do player; isso não é uma consulta à API do marketplace. Mensagens anteriores continuam sendo paginação explícita do usuário, com chave de cursor no cache do servidor, sem prévia automática de histórico anterior.

Contagens adicionais, separadas dos dados de negócio: `proxy.ts` faz leitura de autenticação em solicitações protegidas. `caseReadScope` lê o usuário e a revisão global (2 leituras por execução). A rota de detalhes lê uma identidade/revisão (1). O Sidebar conserva suas leituras de usuário, configuração e contadores; essas leituras globais não foram removidas nem apresentadas como dados do caso. Portanto, um GET frio de detalhe contém 3 leituras adicionais do novo mecanismo, além da autenticação já existente. Reabertura atendida pelo cliente não chega ao servidor e não faz essas leituras.

Trocar filtros/conta consulta somente a partição correspondente. Foco do navegador solicita acesso ao cache, sem bypass ou temporizador de consulta a cada 15 minutos. Abertura de CHAT/Timeline/evidências não cria consultas individuais. `GlobalMarketplaceNotifications` já desabilita seu polling na Central; a verificação de uma operação explicitamente solicitada no ML conserva o polling operacional existente.

Invalidação: triggers de alteração real incrementam revisão local/global; mensagens vinculadas ao caso e operações ML também atualizam revisão. Uma nova listagem/revisão recebida usa outra chave. Resultados conhecidos por `ClaimControls` substituem o cache imediatamente. Alteração apenas de timestamps técnicos não invalida. Nenhum polling novo foi adicionado.

Limites: cache de servidor é por processo; outra instância fria da Vercel poderá repetir a primeira leitura local. A mesma aba conserva o cache mesmo em navegação completa, via `sessionStorage`. Não há promessa de invalidação instantânea para uma alteração remota ainda desconhecida pela página: ela será observada pela próxima leitura/revisão ou acesso após TTL. Auth e metadados leves continuam sendo consultados em HTTP real. Sem armazenamento do navegador, a persistência entre recargas completas depende do cache do servidor. Evidências e paginação anteriores continuam com seus recursos existentes.

## B. Mercado Livre

Notificação `post_purchase` → recepção autenticada existente → `enqueue_marketplace_activity_idempotently` → `marketplace_activities` → `marketplace-queue-worker` → `processNewCaseEvent` → `enrichMercadoLivreClaim` → `persist_marketplace_case`. Os demais tópicos/pedidos/chats permanecem nos caminhos existentes.

Antes, `reconcileMarketplaceClaims` executava no ciclo de conversas de 15 minutos, verificando até 10 operações financeiras incertas e até 5 reclamações `opened`, com enriquecimento/persistência direta. Essa seleção limitada não garantia acompanhamento de todos os casos abertos. A parte de casos foi removida dessa rotina; a confirmação de operações incertas permanece com sua frequência anterior, sem alterar regras financeiras.

Agora, `scripts/marketplace-worker.ts` agenda segurança a cada 3.600.000 ms, independentemente do ciclo de conversas. `enqueue_due_marketplace_cases` seleciona apenas identidades elegíveis, em blocos de até 100, e enfileira `case_reconcile` na **fila existente**. O processamento mantém o tamanho de lote e as retentativas da fila. Webhooks têm prioridade sobre segurança. Não cria cron paralelo, varredura de pedidos ou outra fila.

Estados reaproveitados da integração/listagem: ML `claim` em `open`, `opened`, `reopened`; Shopee `return` em `REQUESTED`, `PROCESSING`, `ACCEPTED`, `JUDGING`, `SELLER_DISPUTE`. Conta inativa, estados terminais e estados desconhecidos não entram. Disputa é estágio do claim e continua acompanhada enquanto o status permanece aberto. Não se infere estado do caso a partir de status logístico ou de pedido. Casos com estados novos/desconhecidos ficam fora do acompanhamento automático até que o mapeamento seja comprovado; continuam visíveis na categoria existente.

Documentação primária ML: [Gerenciar reclamações](https://developers.mercadolivre.com.br/pt_br/produto-consulta-de-usuarios/gerenciar-reclamacoes) descreve estados `opened`/`closed` e estágios; [Notificações](https://developers.mercadolivre.com.br/pt_br/descricao-de-produtos/produto-receba-notificacoes) descreve o mecanismo de eventos. Variantes adicionais `open`/`reopened` são compatibilidade já existente no código, não novos estados atribuídos à documentação.

## C. Shopee e deduplicação

Fluxo confirmado no código atual: código 29 → fila de atividades → worker → GET `/api/v2/returns/get_return_detail` → normalização → persistência. Não existia reconciliação periódica específica de devoluções Shopee. Agora o job de segurança usa exatamente esse enriquecedor, sem sincronizar pedido em cascata e sem consulta na abertura da tela.

O webhook permanece com seu processamento de pedidos já existente. A reconciliação não substitui notificações. O planejamento verifica notificações pendentes do caso/conta. Antes da consulta, o worker verifica novamente a elegibilidade, notificação pendente e se um webhook já atualizou o caso depois do agendamento. Webhook e segurança compartilham lease persistente por UUID durante API + persistência. Notificação pendente ou atualização recente evita outra consulta; lease ocupado usa retentativa da fila. Nenhuma operação financeira usa esse job.

Idempotência: source_key por caso; external_event_id por caso/janela horária; lock transacional curto para o planejador; exclusão de jobs queued/retry/processing; lease de 10 minutos com UUID de proprietário. Reinício não perde controle. Proprietário antigo não libera o lease novo. GETs de detalhe têm timeout de 20 segundos por requisição. A fila mantém cinco tentativas e seus atrasos existentes; falha na API/persistência não marca atualização bem-sucedida. Repetição é de leitura, não de reembolso.

Periodicidade é uma rodada horária do worker, com próxima janela persistida no banco. Instância parada, fila ocupada ou limite da API pode atrasar a atualização; não há garantia de prazo absoluto de 60 minutos em indisponibilidade. A próxima janela é a fronteira da hora, evitando perder uma rodada por segundos de processamento; reinício pode antecipar uma consulta dentro da janela seguinte. Essa cadência não muda os 15 minutos de Chats/Perguntas nem a verificação financeira rápida existente.

Após persistir encerramento, o próximo planejamento exclui o caso; um job já enfileirado revalida o status e não chama a API. Um webhook explícito ainda pode atualizar um caso encerrado, como anteriormente. Não há varredura periódica do conteúdo de casos fechados.

Os estados Shopee foram reaproveitados do código atual, mantendo a limitação documental já registrada na auditoria anterior: não foi possível obter o conteúdo oficial autenticado da documentação Shopee. Não foi inventado endpoint, vídeo, prazo, data ou permissão. A configuração efetiva do processo em execução na VPS e a inscrição remota de webhooks não foram verificadas nesta tarefa; as conclusões de frequência são do código/configuração local, não telemetria da VPS.

## D. Persistência e consumo

`persist_marketplace_case` compara um SHA-256 determinístico do snapshot, mensagens, eventos, prazos, ações e evidências sob lock da linha. Normalização ignora timestamps de processamento, diferenças de ordem de JSON/arrays, campos vazios equivalentes e representações ISO equivalentes. Mudança real de prazo, mensagem, status, evento ou evidência altera o hash. Um detalhe antigo não substitui o baseline novo. Casos antigos podem obter o baseline a partir da última observação completa persistida.

Se igual: retorno antes do writer original, **zero INSERT/UPDATE/UPSERT/DELETE de negócio**, sem alteração de `updated_at`, observação, timeline, mensagens, evidências ou cascata. Se mudou: reaproveita o writer existente; evita reinserir referências de evidência já armazenadas, atualizando metadados somente se mudaram. Não baixa nem replica mídia. Push parcial não substitui projeção completa já validada. O hash e leases ficam em tabela operacional; baseline inicial pode gerar uma gravação operacional única.

Estimativa de GETs externos por rodada, sem webhooks adicionais, falhas ou renovação OAuth: `6..10 × M + S`, onde M = claims ML elegíveis e S = returns Shopee elegíveis. ML usa claim + reputation/messages/actions/statuses/resolutions, com motivo/pedido/billing/devolução quando aplicáveis. Shopee usa um get_return_detail. Retentativas e eventos podem aumentar; notificações pendentes/recém-processadas podem reduzir. Renovação de token é condicional e continua no mecanismo existente.

| Casos abertos | GETs externos por hora | GETs externos por 24 horas |
|---|---:|---:|
| 10 ML + 10 Shopee | 70–110 | 1.680–2.640 |
| 100 ML + 100 Shopee | 700–1.100 | 16.800–26.400 |

São estimativas derivadas do código, não medições das contas ML-ED/ML-GI/SP-ED/SP-GI. Não houve reconciliação real dessas contas. A antiga rotina ML podia fazer até 20 bundles por hora (5 por ciclo de 15 min), repetindo seleção; o novo custo depende do total elegível e acompanha todos eles.

Leituras Supabase do job incluem identidade, última verificação e conta, além de RPCs de planejamento, lease, evento pendente e persistência. Cada RPC executa múltiplas operações SQL; não confundir chamadas HTTP com linhas/consultas internas. Quantidades exatas em produção não foram medidas, pois variam com cache de configuração/token, tamanho da fila e mudanças reais. Não há custo de API externa associado à navegação.

Escritas operacionais inevitáveis por job: enfileiramento, claim, lease, liberação/última verificação/próxima janela, resultado e histórico da fila, além do avanço da janela no planejamento. Elas permanecem rastreáveis e separadas das tabelas de negócio. Credenciais podem ser atualizadas por renovação OAuth. Triggers e revisão somente acompanham alterações reais; uma mudança completa pode incrementar revisão em mais de uma operação dentro da mesma transação, sem consultas adicionais da interface.

Pontos ainda não otimizados: primeira leitura consolidada conserva as consultas existentes de produtos/snapshot; paginação de mensagens anteriores ainda lê o conjunto local consolidado por cursor, com cache no servidor; metadados/autorização do HTTP real; acesso a instância fria; histórico operacional da fila. Não foi criado cache distribuído adicional, nem removidos controles para economizar leituras.

## E. Alterações, validação e infraestrutura

Criados:
- `lib/case-read-cache.ts`, `lib/marketplace-case-read-cache.ts`, `app/central-reclamacoes/case-detail-cache.ts`.
- `lib/marketplace-case-reconciliation.ts`.
- `supabase/migrations/20261008043943_marketplace_case_cache_reconciliation.sql`.
- `tests/marketplace-case-cache.test.ts`, `tests/marketplace-case-reconciliation.test.ts`, `tests/marketplace-case-reconciliation-sql.test.mjs`.
- Este relatório.

Modificados:
- `app/central-reclamacoes/page.tsx`, `app/central-reclamacoes/[id]/page.tsx`, `app/central-reclamacoes/case-grid.tsx`, `app/api/central-reclamacoes/[id]/route.ts`.
- `lib/marketplace-case-list.ts`, `lib/marketplace-cases.ts`, `lib/marketplace-claim-service.ts`, `lib/marketplace-queue-worker.ts`, `lib/marketplace-case-enrichment.ts`, `lib/mercado-livre.ts`, `lib/marketplaces/shopee/client.ts`.
- `scripts/marketplace-worker.ts`, `scripts/smart-test-runner.mjs`, `scripts/preview-marketplace-case-layout.ts`.
- `tests/central-reclamacoes-page.test.ts`, `tests/marketplace-case-layout.test.ts`.

Testes novos: TTL, concorrência, isolamento de usuário/marketplace/quatro contas, erro/resposta incompleta, atualização conhecida, corridas de invalidação; contagens dos leitores reais com fixtures; segurança horária e webhook; falhas API/persistência; encerramento/estado desconhecido/inatividade; reinício/lease expirado/proprietário divergente; prioridade da fila; baseline legado; datas/JSON equivalentes; zero escritas de negócio por triggers de auditoria; mudança de mensagem/status/prazo/evidência; privilégios dos RPCs. PostgreSQL isolado PGlite usa as migrations reais relevantes. Nenhum teste financeiro real.

Os 21 testes direcionados executados nesta revisão passaram, incluindo a renderização estática real dos componentes ML/Shopee, Timeline, evidências e preservação dos campos. O Smart Check completo passou com 265 testes, TypeScript e compilação aprovados. Não houve sessão visual interativa nova autenticada na Central real; a alteração é de leitura/cache e worker, sem mudança de CSS. A validação e classificação pós-commit são registradas na entrega.

Migration necessária para exclusão entre processos, retomada após reinício, comparação atômica e revisão de cache. RLS habilitado; tabelas/RPCs restritos ao service_role; security invoker e search_path fixo. Índice parcial contém apenas identidades de estados abertos; índice operacional usa próxima janela. Os índices existentes de venda/comprador não atendem essa seleção. Não foi alegado EXPLAIN de produção. [Funções de banco Supabase](https://supabase.com/docs/guides/database/functions) fundamenta security invoker e controle de privilégios.

| Impacto da tarefa | Classificação |
|---|---|
| Vercel | Sim |
| Worker/VPS | Sim |
| git pull na VPS | Sim, somente na publicação futura autorizada |
| npm ci | Não; package.json/package-lock.json não alterados |
| pm2 restart marketplace-worker --update-env | Sim, somente na publicação futura autorizada |
| Migration | Sim; criada e testada localmente, não aplicada remotamente |
| Dependências | Não |

A publicação está pendente. Antes de publicar, o Smart Deploy deve determinar as ações cumulativas reais; a migration precisa estar disponível antes de ativar os leitores e worker novos. Não declarar READY sem publicação confirmada. Comandos de revisão autorizados: `npm run check:smart` e `npm run deploy:smart -- --dry-run`. `npm run deploy:smart -- --execute` permanece reservado para autorização posterior.
