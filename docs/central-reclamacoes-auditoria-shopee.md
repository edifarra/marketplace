# Central — ajustes definitivos e auditoria Shopee (08/10/2026)

Continuação de `eb1ae92336add7ad08cb1695d99cd75756cafda7`. Este documento substitui as conclusões preliminares sobre vídeos/datas em `central-reclamacoes-layout-local.md`. Não houve deploy, push, alteração de banco, refresh de credenciais, ação financeira, instalação de dependências, alteração de frequência ou atualização da VPS.

## A. Layout

- Grid com header superior, primeira linha CHAT / Dados Gerais + comprador quando disponível + Timeline, segunda linha histórico anterior / Ações. As células se estendem pela altura natural da linha; nenhuma altura fixa de página foi imposta.
- CHAT inclui solicitação/evidências na rolagem interna. Histórico anterior contém exclusivamente o link contextual para Chats e Perguntas; removidas as consultas e o processamento exclusivos da prévia ML. A conversa principal e sua paginação permanecem.
- ML mantém todos os eventos, ordem e indicadores, com limite de 28rem (aproximadamente dez eventos simples). Inicialização no fim; atualização não desloca quem está lendo eventos antigos. Eventos extensos podem ocupar mais linhas.
- Shopee mantém quatro etapas, sem negrito nos textos e com atual laranja. Removido Resultado solicitado. Motivo permanece no header e CHAT. Botões ML na mesma linha desktop, com largura flexível, bordas arredondadas e texto completo; mobile permite adaptação.
- Vídeo utiliza `video` com controles, miniatura, `preload="none"`, sem autoplay e mensagem de falha. Fotografias mantêm ampliação por link. Não há cópia para Cloudinary/VPS nem renovação remota ao abrir a tela.

Validação visual em navegador com componentes reais e dados fictícios, por `scripts/preview-marketplace-case-layout.ts` (servidor isolado, sem banco/API): desktop 1280px e mobile 390×844. ML: bordas CHAT/Timeline ambas 1152px; histórico/Ações ambas 1277,60px; três botões com topo 1223,20px. Shopee com comprador: primeira linha 898,40px e segunda 1164px; sem comprador: diferença de bordas da primeira linha menor que 0,001px e segunda igual a zero. Nenhum overflow horizontal; CHAT mobile: área 416px, conteúdo 3087px, rolagem interna. Todos os textos de eventos ML medidos com peso 400. A prévia é estática: comportamento de hooks/scroll foi validado separadamente por teste automatizado, não por essa renderização.

## B. Dados Shopee

Evidência real: leituras Supabase e uma chamada autenticada **GET** com token existente a `/api/v2/returns/get_return_detail`, para SP-ED/caso `2610010GAGYGFBA`, sem persistir o resultado. Não foram expostas credenciais. URLs de mídia foram verificadas somente por HEAD, sem baixar arquivos.

| Informação | Origem concreta | Recebida / persistida antes | Exibição e alteração |
|---|---|---|---|
| Motivo | detalhe `reason` → normalizador `reason_code` | Sim; `marketplace_cases.content` e observações | Header/CHAT, código FUNCTIONAL_DMG; tradução existente |
| Descrição | detalhe `text_reason` → `buyer_description` | Sim, content/snapshot | CHAT e campos existentes; nenhum texto fabricado |
| Reembolso | detalhe `refund_amount`, `currency` | Sim; 29 BRL no caso real | CHAT; valor solicitado não prova reembolso executado |
| Fotos | detalhe `image` | Sim; uma referência em `marketplace_case_evidence` | Ampliação preservada |
| Vídeos | detalhe **`buyer_videos[].video_url`**, **`thumbnail_url`** | Recebidos na resposta real; ausentes na persistência antiga | Normalização agora gera evidência video e metadata.thumbnail_url; próximas sincronizações do worker persistem no contrato existente |
| Criação | detalhe **`create_time`**, Unix segundos | Recebida; não preservada como data de criação | Agora content/snapshot.return_created_at; sem backfill remoto ao abrir |
| Alterações de etapas | push29 `data.updated_values[].update_field/old_value/new_value/update_time` | Raw em `marketplace_activities`; snapshots antigos descartavam os marcos | Novos snapshots/content.return_milestones; recuperação legada por IDs exatos de origem vinculados às observações |
| Prazo vendedor | detalhe `return_seller_due_date` | Sim; `marketplace_case_deadlines`, purpose=seller_response, responsible=seller | Quadro Ações, pendente/expirado quando timestamp permite; sem inventar dois dias |
| Estado atual | push/detalhe return_status, logistics_status, validation_type | Sim; casos/content/reverse_logistics | PROCESSING + seller_validation + DELIVERY_DONE + prazo vendedor permite representar validação atual; não prova elegibilidade financeira |
| Elegibilidade de ações | detalhe follow_up_action_list e demais capacidades normalizadas | Lista null no caso, capabilities_known=false | Confirmação financeira desabilitada; sem endpoint comprovado |

Fluxo de persistência: `lib/marketplace-case-domain.ts` → `persist_marketplace_case` → `marketplace_cases`, `marketplace_case_observations`, `marketplace_case_evidence`, `marketplace_case_deadlines`, `marketplace_case_actions`, `marketplace_case_timeline`. O detalhe integral não era arquivado por esse fluxo. JSON e metadados existentes acomodam vídeo e marcos; nenhuma migration.

### Datas do caso real (Brasília / America/Sao_Paulo)

| Campo/evidência | Valor original | Data apresentada / significado |
|---|---|---|
| detalhe create_time | 1790861863 | 01/10/2026 10:37:43 — criação da solicitação |
| push return_status inicial update_time | 1790861864 | 01/10/2026 10:37:44 — alteração notificada; fallback explicitamente identificado como notificação |
| push LOGISTICS_REQUEST_CREATED → LOGISTICS_PICKUP_DONE update_time | 1791037288 | 03/10/2026 11:21:28 — **postagem confirmada**, não início da espera pela postagem |
| push PICKUP_DONE → DELIVERY_DONE update_time | 1791310865 | 06/10/2026 15:21:05 — logística; não acrescentada à Timeline de quatro etapas |
| return_seller_due_date | 1791570065 | 09/10/2026 15:21:05 — prazo de decisão, não ocorrência |
| return_ship_due_date | 1791466822 | 08/10/2026 10:40:22 — prazo de envio |
| due_date | 1791034663 | 03/10/2026 10:37:43 — finalidade não comprovada, não utilizada como etapa |

O evento de 01/10 foi recebido às 13:37:56,736Z e processado às 13:38:22,689Z; o de 03/10 recebido às 14:21:34,645Z e processado às 14:22:09,468Z. Nenhum desses horários substitui update_time. O detalhe observado em 06/10 às 18:21:28,015Z continha update_time 18:21:09Z; isso também não prova quando começou a validação. Datas de validação/finalização permanecem indisponíveis. A legenda da segunda etapa diferencia a data de postagem da data de entrada em espera.

No caso já persistido, a criação exata e o vídeo continuarão ausentes até enriquecimento futuro pelo worker: esta tarefa não escreveu em produção nem enfileirou refresh. As notificações históricas permitem exibir as datas disponíveis sem consultar a Shopee. Não há garantia documental de retenção das URLs: HEAD retornou 200, imagem image/jpg e vídeo video/mp4, sem credencial/parâmetro de expiração; cache-control não equivale a validade contratual. Falha de reprodução gera orientação, sem consultas adicionais.

### Fontes oficiais e limites

Tentativas de consultar o [detalhe de devolução](https://open.shopee.com/documents/v2/v2.returns.get_return_detail?module=102&type=1) e a [página de confirmação](https://open.shopee.com/documents/v2/v2.returns.confirm?module=102&type=1) retornaram 403; no navegador, a documentação não apresentou conteúdo utilizável. A segunda URL é uma tentativa de localização, **não comprovação de endpoint compatível**. Campos descritos como confirmados acima foram observados no código e/ou resposta real; não se atribuiu à documentação inacessível um contrato não verificado. Vídeos por notificações não foram encontrados nos eventos inspecionados; isso não prova impossibilidade em outros casos.

## C. Sincronização

1. `app/api/webhooks/shopee/route.ts`: valida assinatura HMAC com chaves dos parceiros ED/GI. `enqueueMarketplaceActivity`, em `lib/marketplace-queue.ts`, usa `enqueue_marketplace_activity_idempotently`; dedupe por identificador de mensagem/requisição/evento ou hash. Raw preservado, assinatura inválida registrada como erro.
2. `lib/marketplace-queue-worker.ts`: código **29** associa shop_id/conta/assinatura, processa devolução e pedido por caminhos independentes (`processCaseAndOrders` / `processNewCaseEvent`). Identificadores e alterações do push não substituem o detalhe completo.
3. `lib/marketplace-case-enrichment.ts::enrichShopeeReturn`: usa `ShopeeClient.getReturnDetail`, **GET /api/v2/returns/get_return_detail**, confere identidade e persiste snapshot normalizado pelo RPC existente. Tentativa de detalhe já bem-sucedida é reutilizada; guarda de rollout evita enriquecer eventos antigos.
4. `lib/marketplace-case-detail.ts::loadCaseDetail` → API interna autenticada → interface: somente Supabase. Abrir, atualizar dados locais ou receber foco de janela não consulta Shopee. Recuperação de datas antigas lê apenas IDs de atividades vinculados ao caso, em lotes de até 100; nenhuma varredura global de JSON ou chat anterior.

Evidência de recepção: 185 atividades code29 no banco inspecionado, 157 processadas e 28 erros (último erro em agosto; último processamento em 06/10). Isso comprova entrega/processamento desse tipo de evento, mas não permite verificar todos os switches de inscrição no console Shopee. Corte efetivo de rollout no banco: 05/10/2026 01:01:43,752Z; eventos de 01/10 e 03/10 ficaram em observações locais sem detalhe remoto. Há retentativas existentes (máximo cinco, atrasos progressivos de 1/2/4/8 minutos, limite de 30); falha esgotada requer intervenção.

**Como uma alteração feita no site chega aqui?** Quando a Shopee entrega code29, a aplicação valida/enfileira; o worker obtém o detalhe e persiste. Não foi encontrado mecanismo de reconciliação periódica de devoluções Shopee. Evento perdido, assinatura rejeitada, falha esgotada, guarda de rollout ou worker parado podem deixar um caso aberto desatualizado indefinidamente. Casos fechados também não possuem consultas periódicas de devolução. O prazo, a situação atual e a configuração de validação têm origem comprovada no detalhe, mas não há registro histórico completo de todas as mudanças do site.

### Frequências: configuração versus execução

- `scripts/marketplace-worker.ts` / configuração JSON / ecosystem PM2: conversationSyncIntervalMs=900000 (15min), batch=5, espera ociosa máxima=60s. O ciclo de segurança chama sincronização de conversas e `reconcileMarketplaceClaims`; **este último consulta somente ML** (até cinco abertos e dez operações incertas). Esses números não são um cron de devoluções Shopee.
- `vercel.json`: recuperação de pedidos Shopee 05:15 UTC, fila 05:30 UTC, chats 06:15 UTC, diariamente (Brasília 02:15/02:30/03:15); recuperação de pedidos não recupera devoluções. Configuração do repositório, não confirmação da execução no hosting.
- Cron Supabase efetivamente consultado: pipeline `0 * * * *` e Telegram `*/5 * * * *`, ativos; nenhum é reconciliação de devoluções.
- A tentativa de SSH somente leitura foi recusada por autenticação. Não foi possível confirmar processo PM2, variáveis e intervalo efetivamente em execução. Nenhuma frequência foi alterada.

### Proposta para aprovação futura

Priorizar code29 com fila existente. Acrescentar reconciliação rotativa somente de casos abertos/pendentes, sem recorrer à abertura da tela. Fechados saem da rotina após confirmação; resultado operacional incerto exige trilha específica, sem repetição de POST financeiro.

Como candidato inicial **condicionado à medição**, aproveitar o ciclo de segurança configurado de 15min para até cinco casos urgentes por rodada (prazo comprovado inferior a 24h); casos estáveis poderiam ter janela de 60min. Justificativa: cinco GET por rodada representam até 20/h por worker, enquanto uma janela de 60min reduz quatro vezes leituras estáveis. Para N urgentes, a cobertura com lote cinco demora ceil(N/5)×15min: se isso ultrapassar o SLA ou a margem do prazo, o candidato é inadequado e exige capacidade/limite diferente. Antes de definir frequência, verificar PM2 real, rate limits do parceiro, N por conta, latência da fila e SLA de atuação; priorizar prazo crescente, rotacionar por conta e manter reserva para eventos. Não se considera 15/60min um SLA aprovado nem um novo intervalo implementado.

## D. Ações e filas

Não foi comprovado o endpoint/método/permissão/estados/parâmetros que encerram uma **devolução física recebida** com reembolso. Acesso negado à documentação e follow_up_action_list null impedem habilitar execução. Não se confundiu confirmação de reembolso sem devolução com essa operação.

O quadro mostra botão desabilitado apenas no contexto observado PROCESSING + seller_validation + LOGISTICS_DELIVERY_DONE; isso indica contexto de recebimento, não autorização financeira. Exibe prazo real e a limitação. Outros estados não recebem botão fictício. Orientação: “Para disputa, acesse o site da Shopee.” Nenhuma API operacional Shopee, fila financeira ou disputa foi implementada, nem operação real testada.

Uma futura execução comprovada deve reutilizar `outgoing_marketplace_activities` e os padrões de autenticação/autorização, fingerprint da confirmação, barreira durável de envio, revalidação de conta/caso/estado/prazo/valor e resultado remoto já usados em `lib/marketplace-claim-service.ts` e `lib/marketplace-claim-operations.ts`. A entrada na fila significa solicitada; processing significa em processamento; somente evidência Shopee pode confirmar conclusão. Timeout após envio deve ficar incerto e reconciliar por leitura, sem novo POST automático. A operação correta e sua forma de reconciliação/idempotência ainda dependem do contrato oficial; não se afirma que a estrutura ML possa ser copiada sem adaptar esse contrato.

## E. Infraestrutura e testes

- Frontend/Vercel: sim, componentes, CSS e leitura da API interna.
- Worker/VPS: sim, `marketplace-case-domain.ts` importa o normalizador de marcos e preserva vídeo/criação em snapshots futuros.
- Migration: não; estruturas JSON/evidence existentes. Dependências/package-lock: não. `npm ci`: não.
- Alterações não aplicadas em produção. Publicação e atualização do worker permanecem pendentes de autorização e classificação cumulativa do Smart Deploy.
- 46 testes direcionados passaram: layout/render, ausência de negrito, estados desconhecidos, datas/legado, vídeo seguro, ausência de preview automático, escopo de conversas, scroll ML e operações ML com mocks (duplicidade, concorrência, timeout incerto, prazos, revalidação). Sem operações financeiras reais.
- Build Next passou. ESLint identificou três avisos tratados como erro por set-state-in-effect já existentes em CaseGrid/ClaimControls; não foram refatorados fora do escopo. A nova ocorrência de Date.now no render Shopee foi corrigida com inicialização de estado; novos arquivos passam no lint direcionado. A primeira execução manual dos testes omitiu o registrador server-only e falhou no carregamento; repetição com o registrador do projeto passou.
- Após commit: executar check:smart e deploy:smart -- --dry-run; conferir plano cumulativo, sem --execute. A validação também deve usar o baseline confirmado quando necessário, para não reduzir a checagem a um working tree limpo.

Arquivos da implementação: `app/central-reclamacoes/{case-grid,case-evidence,case-timeline,claim-controls,shopee-presentation,shopee-actions}.tsx` (shopee-presentation é .ts), `cases.module.css`, `lib/{marketplace-case-detail,marketplace-case-domain,shopee-return-milestones}.ts`; validação: `tests/{marketplace-case-layout,marketplace-conversation-scope,shopee-return-audit}.test.ts`, `scripts/preview-marketplace-case-layout.ts` e este relatório.
