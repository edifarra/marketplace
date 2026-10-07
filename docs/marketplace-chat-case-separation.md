# Separação entre chats e casos — auditoria local (07/10/2026)

## Causa raiz e diferenças entre marketplaces

A migration de operações de reclamação introduziu `conversation_type = 'claim'` e a identidade `claim:<external_case_id>`. A última definição da RPC `get_marketplace_conversation_page` selecionava qualquer tipo de conversa. A API `/api/chats/changes` hidratava qualquer conversa alterada. Assim, mensagens oficiais de reclamação do Mercado Livre podiam entrar na página inicial e reaparecer pelo polling. O executor de respostas tratava qualquer tipo diferente de pergunta como pós-venda, permitindo que um `claim` fosse enviado pela API de mensagens do pack.

No Mercado Livre, perguntas, mensagens de pack e mensagens de reclamação já têm caminhos de ingestão separados. `persist_marketplace_case` grava as mensagens oficiais do caso em sua própria conversa; conflito por `(conversation_id, external_message_id)` preserva a identidade nos reprocessamentos. `claim_action` utiliza o endpoint oficial da reclamação e não passa pelo executor de chats. Nenhum histórico precisa ser movido.

Na Shopee, a integração consulta `sellerchat` por `conversation_id` e persiste o chat normal como `chat`. Eventos de devolução (push 29) usam `return_sn` e a API de detalhe de devolução; esse adaptador não persiste um canal oficial de mensagens da devolução. A tela de casos, contudo, apresentava o chat normal vinculado por marketplace/conta/pedido sob o título genérico “Chat”. Isso confundia contexto com mensagens do caso.

O código não demonstra que a Shopee fornece mensagens oficiais de disputa e mensagens normais no mesmo endpoint, nem fornece um discriminador oficial por mensagem para essa situação. Reutilizar `conversation_id`, encontrar `return_sn` no conteúdo, mencionar reclamação ou receber uma mensagem depois da abertura não prova sua classificação. Nenhuma dessas condições provoca reclassificação ou ocultação automática nesta correção. Eventos reais e documentação específica do payload serão necessários para resolver qualquer caso misto ainda não identificado; não houve consulta a produção.

## Regras implementadas

- Chats aceita explicitamente apenas `question`, `chat` e `post_sale`, no SQL antes do agrupamento, contagem e paginação, na hidratação inicial, na hidratação incremental e nas funções compartilhadas de apresentação/merge.
- O cursor incremental observa todos os tipos. IDs alterados de casos continuam sendo retornados para remover eventuais linhas vazadas, enquanto `changes` não contém esses casos. Filtrar o cursor também esconderia a transição necessária para retirar uma linha antiga.
- A existência, encerramento ou reabertura de caso não muda o chat normal do pedido. Mensagens normais posteriores também permanecem acessíveis.
- A central de casos identifica mensagens oficiais como “Mensagens do caso” e chats normais como “Histórico normal — contexto do pedido”. O contexto é somente leitura.
- Para claims do Mercado Livre, consulta separada lê os chats normais do mesmo marketplace, conta e pedido; quando há data oficial de abertura, o painel mostra até 100 mensagens anteriores. O corte temporal seleciona apenas contexto anterior: não classifica mensagens posteriores como pertencentes ao caso. Sem data, o painel identifica contexto do pedido sem afirmar que é anterior. Um link abre o histórico completo em Chats e Perguntas com filtros de conta/pedido.
- O vínculo exato de claim exige marketplace, conta, tipo `claim` e ID oficial. O vínculo normal da Shopee mantém a regra conservadora existente de um único resultado inequívoco por conta/pedido.
- Enfileiramento e execução de resposta normal rejeitam tipos fora da lista antes de gravar drafts ou chamar APIs. Tratamento de erro de jobs antigos também evita sobrescrever o estado oficial do caso.
- Sem transferência, exclusão ou duplicação de mensagens no banco. Frequência de reconciliação de 15 minutos preservada. Estoque, anúncios e vendas não foram alterados.

## Arquivos e justificativas

| Arquivo | Alteração |
| --- | --- |
| `lib/marketplace-conversation-scope.ts` | Lista compartilhada de tipos normais e bloqueio de canal de resposta. |
| `lib/marketplace-conversation-view.ts` | Exclusão antes de agrupar e proteção durante o merge do polling. |
| `app/chats-perguntas/page.tsx` | Filtro defensivo na hidratação inicial. |
| `app/api/chats/changes/route.ts` | Mesmo filtro na hidratação incremental; cursor e IDs de remoção preservados. |
| `lib/marketplace-conversations.ts` | Bloqueio no enfileiramento, no worker e na projeção de erro. |
| `lib/marketplace-case-detail.ts` | Contexto separado, com limites de conta/pedido e data oficial. |
| `app/central-reclamacoes/case-grid.tsx` | Identificação visual dos dois históricos e acesso ao histórico completo. |
| `supabase/migrations/20261007233251_separate_chat_and_case_conversations.sql` | Substitui somente a RPC de página, mantendo filtros, SLA, cursor e permissões service role. |
| `tests/marketplace-conversation-scope.test.ts` | Regressões de classificação, polling, contexto, conta e resposta. |
| `tests/marketplace-conversation-scope-sql.test.mjs` | Execução real da RPC em PostgreSQL isolado. |
| `tests/conversation-product-links.test.ts`, `tests/shopee-chat-management.test.ts` | Fixtures agora declaram o tipo normal obrigatório, mantendo as expectativas originais. |
| `scripts/smart-test-runner.mjs` | Fornece o PostgreSQL isolado também ao novo teste SQL. |
| `tests/smart-test-runner.test.mjs` | Confirma o suporte do runner ao novo teste SQL. |
| Este documento | Achados, validações e limites da entrega. |

## Verificação

A bateria relacionada passou com 182 testes, sem falhas ou skips, usando `tsx`, o preload local de `server-only` e PGlite 0.5.8 instalado apenas em diretório temporário. A execução cobre chat normal; claim aberto, encerrado e reaberto no mesmo pedido; contexto anterior; chat normal posterior; devolução Shopee com chat anterior; isolamento entre contas; remoção pelo delta com avanço do cursor; polling repetido; webhook e retry idempotentes; reconciliação de mensagens; canais corretos de resposta; permissões da RPC; contagem/paginação; filtros/SLA; leitura/exclusão de chats Shopee; operações oficiais do claim.

Os testes de webhook/worker usam dados sintéticos, dependências simuladas e PostgreSQL local; não representam uma validação com eventos reais de produção. A nova consulta de contexto também é testada com banco simulado, verificando que as mensagens oficiais e normais são lidas separadamente. Não houve teste visual em navegador autenticado.

`npm run check:smart` passou com 193 testes relacionados, TypeScript e build. O teste do runner foi ampliado em seguida e seus três testes passaram. `npm run build` passou com os avisos preexistentes sobre `<img>`. A primeira execução no sandbox não resolveu arquivos locais existentes; a compilação local fora desse limite conseguiu resolver os módulos. Uma execução adicional de build colidiu com a compilação iniciada pelo smart check; a compilação final do smart check terminou com sucesso. O novo teste SQL usa `PGLITE_MODULE`, o mesmo mecanismo do runner padrão, sem alterar `package.json` ou o lockfile.

## Limites e publicação

É necessária uma migration para corrigir a contagem/paginação na origem. Ela foi criada pelo CLI e executada somente em PostgreSQL isolado, com `security invoker`, revogação de acesso público/anon/authenticated e execução exclusiva do `service_role`. Não foram criadas tabelas ou colunas.

O painel de contexto do Mercado Livre é limitado a 100 mensagens; o histórico completo continua na central de chats. Conversas normais da Shopee com vínculo ambíguo de pedido continuam sem associação automática. Como a Shopee pode usar o mesmo chat do comprador em diferentes pedidos, um vínculo no nível da conversa não comprova o pedido de cada mensagem: o painel é contexto, não prova de que cada mensagem pertence à devolução. Mensagens oficiais de disputa da Shopee sem discriminador comprovado permanecem uma limitação da integração, não uma classificação resolvida por este filtro. Não há novo envio de mensagens de devolução Shopee habilitado.

A entrega é **local e não publicada**, conforme a restrição expressa desta solicitação. Vercel e worker/VPS são impactados quando a correção for publicada. Nenhuma migration remota, deploy, push, atualização de VPS ou reinicialização de PM2 foi executada. A efetividade em produção depende de aplicar a migration antes da aplicação e atualizar também o worker. Como as dependências da aplicação não mudaram, uma futura atualização do worker exige `git pull` e restart com `--update-env`, sem `npm ci`.
