# Revisão econômica da reconciliação — base aae5e0b

Implementação exclusivamente local. Sem deploy, migration remota, VPS, chamadas financeiras ou consultas reais às contas. Cache de 15 minutos, assinatura/autorização de webhooks, ações do usuário e ciclo de Chats/Perguntas de 15 minutos preservados.

## Alternativas avaliadas antes da implementação

Modelos estimados para 100 casos inalterados com tokens válidos, sem retentativas:

| Alternativa | Requisições Supabase | Modificações operacionais de linhas | Jobs novos |
|---|---:|---:|---:|
| Jobs individuais, agrupando captura/preparação/finalização | aproximadamente 125–150 | pelo menos 600 | 100 |
| Jobs de lotes, com leases por caso | aproximadamente 30–50 | aproximadamente 220–320 | 5–20 |
| Verificação somente leitura com leases persistentes, fila apenas para mudanças/falhas | 26 no verificador; até 38 com capturas intercaladas das duas filas | 200 | 0 |

As duas primeiras alternativas são modelos, não implementações medidas. Dependem do tamanho de lote, RPCs agrupadas e histórico agregado. A terceira foi escolhida e testada. Não substitui controles persistentes por memória. Não cria outra fila.

## Fluxo implementado

`claim_marketplace_case_checks(owner,20)` seleciona identidades não terminais e conta na mesma RPC, verifica próxima data, conta ativa, webhook/job pendente e lease. Reserva atomicamente até 20 casos, com SKIP LOCKED e lease de 10 minutos. Não registra atividade de fila para essa leitura.

O worker executa no máximo cinco bundles de leitura em paralelo. Para cada grupo de até cinco, `finish_marketplace_case_checks(owner,results)` compara o hash no banco e verifica o proprietário/validade do lease. Igual: apenas finaliza o controle. Diferente: enfileira a observação completa capturada em `marketplace_activities`, atomicamente com a finalização. Erro externo: enfileira o job de leitura/retry existente, com código fixo sem credenciais. A finalização não escreve dados de negócio.

O dispatcher existente processa `case_reconcile`. Observação capturada: valida a identidade e chama o writer existente sob lease, sem repetir GET remoto. Erro de leitura: utiliza o caminho existente de enriquecimento/retry. A fila mantém seus limites, histórico, tentativas e confirmação. Todas as ações operacionais do usuário e webhooks mantêm as filas existentes.

Um lote de 20 por ciclo permite atendimento normal da fila de entrada e de saída entre lotes. A rodada termina ao receber lote vazio; depois aguarda 60 minutos. Autoridade de elegibilidade/última checagem permanece no banco, não no contador do processo. Reinício respeita leases/datas persistidos. Um processo morto durante leitura deixa lease expirável; outro processo poderá reservar na próxima passagem elegível. Não existe obrigação financeira ou efeito remoto a repetir nesse probe.

Se a RPC de finalização falhar, sua transação não faz uma finalização parcial; os resultados ainda não confirmados conservam leases até expirar. Se a transação comitou mas a resposta se perdeu, repetir finalização do proprietário antigo não recria jobs, pois o lease já foi liberado. Identificador de fila inclui caso, proprietário da rodada e hash: preserva idempotência da mesma verificação e permite transições A→B→A→B em rodadas diferentes. Caso só permanece fora da seleção enquanto existe trabalho pendente ou ainda não venceu a próxima checagem.

Estados elegíveis preservados: ML claim open/opened/reopened; Shopee return REQUESTED/PROCESSING/ACCEPTED/JUDGING/SELLER_DISPUTE. Estados desconhecidos continuam sem inferência automática. O job capturado pode persistir o fechamento detectado; próximas verificações não selecionam o encerrado. A validade de 60 minutos agora parte da finalização persistida, sem antecipação por fronteira da hora.

## Custos para 100 casos inalterados

Condições: baseline/hash já disponível, contas ativas, tokens válidos, todos elegíveis/vencidos, sem novos webhooks, mudanças, falhas, retentativas, lease concorrente ou grandes atrasos. Primeiro preenchimento de detalhes/hashes legados pode gerar trabalho na fila e custos adicionais.

| Componente Supabase | Quantidade |
|---|---:|
| RPC de reserva: cinco lotes de 20 + confirmação vazia | 6 |
| RPC de comparação/finalização: vinte grupos de 5 | 20 |
| SELECTs HTTP individuais de caso/controle/conta | 0 |
| Total do verificador | 26 |
| Capturas da fila de entrada intercaladas, no worker completo | até 6 |
| Capturas da fila de saída intercaladas, no worker completo | até 6 |
| Total modelado incluindo essas capturas existentes | até 38 |

26 RPCs foram contadas no teste executando o runner real com mocks. As RPCs reais foram exercitadas em PostgreSQL isolado com 100 casos. As 12 capturas adicionais são derivadas dos seis ciclos do worker; não foram medidas contra produção. Não são 38 chamadas externas nem 38 SELECTs SQL. Cada RPC executa consultas internas, comparação e verificação de índices; quantidade de páginas/linhas lidas depende do banco/plano e não foi medida em produção. O processo também mantém o custo ocioso e os demais fluxos existentes, fora desta rodada.

| Linhas modificadas | Quantidade por rodada |
|---|---:|
| marketplace_case_sync_control: reserva | 100 UPDATEs |
| marketplace_case_sync_control: liberação/última checagem/próxima data | 100 UPDATEs |
| marketplace_activities: INSERT/UPDATE/DELETE | 0 / 0 / 0 |
| marketplace_activity_history: INSERT/UPDATE/DELETE | 0 / 0 / 0 |
| Dados de negócio do caso | 0 |
| Total | 200 modificações |

200 modificações de linhas foram contadas por triggers de auditoria no banco isolado. Nenhum incremento de revisão, updated_at de caso, nova observação, mensagem, timeline ou evidência quando igual. Redução do verificador: 922→26 requisições (97,2%); incluindo 12 capturas intercaladas: 922→38 (95,9%). Modificações operacionais: 700→200 (71,4%). A comparação anterior de 922 já excluía as capturas de saída, portanto 38 é uma apresentação conservadora mais abrangente, não uma medição comparável de todo o processo.

Ainda grava owner/lease e, na finalização, last_checked_at/next_due_at/failures/last_error no controle. Mantém rastreabilidade do estado e última verificação por caso, mas não cria histórico completo de cada sucesso inalterado. Logs do worker resumem cada lote. Mudanças/falhas que entram na fila têm histórico completo do processamento existente. Em 24 horas estáveis: 624 RPCs do verificador, até 912 incluindo as capturas modeladas; 4.800 modificações de controle; zero jobs/registro de histórico de fila e zero escritas de negócio por segurança.

## Auditoria das consultas externas ML

Mantidos todos os recursos relevantes. [Gerenciar reclamações](https://developers.mercadolivre.com.br/pt_br/produto-consulta-de-usuarios/gerenciar-reclamacoes) descreve recursos separados de reputação, motivo e histórico; [resoluções esperadas](https://developers.mercadolivre.com.br/pt_br/gerenciar-resolucao-de-reclamacoes) possui seu próprio last_updated; [mensagens](https://developers.mercadolivre.com.br/pt_br/gerenciar-mensagem-de-uma-eclamacao) e [notificações](https://developers.mercadolivre.com.br/pt_br/descricao-de-produtos/produto-receba-notificacoes) também têm mecanismos próprios. Não foi encontrada garantia documental de que last_updated do claim funcione como versão conjunta de todos esses recursos. Não usar esse campo sozinho para suprimir leituras de mensagens, anexos, ações, resolução, devolução ou reputação.

Também não foi comprovado suporte de ETag/consulta condicional ou endpoint agregador com cobertura equivalente. Cachear motivo/pedido/dados fiscais por rodada poderia economizar GETs, mas exigiria pressupor imutabilidade ou aceitar uma janela de perda de atualização entre casos. Foi preservada a cobertura atual. O token é obtido uma única vez por bundle ML, evitando renovações repetidas entre recursos do mesmo bundle; não se promete deduplicação global OAuth entre diferentes bundles/processos.

| 100 casos elegíveis | GETs ML/hora | GETs Shopee/hora |
|---|---:|---:|
| Todos ML | 600–1.000 | 0 |
| Todos Shopee | 0 | 100 |
| 50 ML / 50 Shopee | 300–500 | 50 |

Números externos são estimativas derivadas do código, não medições reais. A faixa ML permanece porque reduzir sem prova poderia deixar mudanças legítimas invisíveis. Shopee continua usando um get_return_detail por caso. Mudança capturada não gera outro GET ao processar sua observação na fila; falhas/retries/OAuth/webhooks aumentam o total.

## Revisão da migration/hash/cache

Revisada a migration local ainda não aplicada `20261008043943_marketplace_case_cache_reconciliation.sql`; não inventada outra versão nem executado SQL remoto. O planejador que criava job para cada caso foi removido. Novas RPCs restritas ao service_role com security invoker/search_path fixo, reutilizando tabelas/índices operacionais. Nenhum cron, nova dependência ou alteração em estoque/pedidos/anúncios. A aplicação futura precisa validar que a versão antiga não foi aplicada manualmente antes de utilizar este arquivo revisado.

Hash: metadados técnicos são retirados por caminhos explícitos (enrichment do snapshot, timestamps técnicos das ações, origem/observação das evidências, raw_value de prazo cuja data normalizada é válida). Não remove genericamente source/observed_at de objetos de negócio, nem espaços significativos do texto. Arrays arbitrários preservam ordem e duplicatas; apenas coleções identificadas de ações/prazos/evidências/mensagens/eventos são comparadas como conjuntos ordenados, preservando multiplicidade. Datas só são normalizadas em campos temporais conhecidos com offset explícito; datas sem timezone não recebem timezone inventado. Raw_value de prazo desconhecido permanece na comparação.

Writer completo suprime seus incrementos intermediários de revisão e faz uma atualização de revisão por caso e uma global no final. Outros eventos/mensagens/operações conservam triggers de invalidação. Evidências existentes não recebem UPDATE apenas por timestamp de observação. Bootstrap legado ML agora preserva sender_role e source dos eventos, evitando falsa diferença de hash. Cache frontend de 15 minutos e suas limitações por instância permanecem inalterados.

## Validação e limites

Testes de 100 casos: contagem 26 RPCs/200 modificações/0 fila/0 negócio; concorrência entre reservas; webhook versus lease; repetição/reinício/expiração/proprietário errado; erro API/persistência; enfileiramento atômico; processamento da observação pela fila sem GET duplicado; pausa entre lotes; baseline legado ML/Shopee; cache de 15 minutos; incremento único das revisões; preservação de texto/espaços/campos aninhados/ordem/duplicatas; alteração de mensagem/anexo/prazo/status/estágio/reputação/dados de compra/resolução sem mudar timestamp raiz. São testes sobre o contrato atual normalizado, não prova sobre todos os campos futuros da API.

Limites: first bootstrap pode criar jobs; a fila/processo pode atrasar atualização; lease expirado só permite nova tentativa na passagem elegível; ainda existem 200 modificações mínimas para exclusão e resultado duráveis; chamadas externas ML não reduzidas sem garantia; registro histórico por sucesso inalterado foi substituído pelo estado/última verificação e logs de lote. Não foi medida carga real, EXPLAIN remoto, bytes transferidos ou configuração ativa da VPS.

Arquivos alterados: lib/marketplace-case-reconciliation.ts; lib/marketplace-case-enrichment.ts; scripts/marketplace-worker.ts; supabase/migrations/20261008043943_marketplace_case_cache_reconciliation.sql; tests/marketplace-case-reconciliation.test.ts; tests/marketplace-case-reconciliation-sql.test.mjs; docs/central-reclamacoes-cache-reconciliacao-local.md; este relatório. Smart Commit também regenera .smart-deploy-plan.json.

Impactos: Vercel sim (enriquecedor compartilhado usado por preparação de ações ML); worker/VPS sim; git pull sim na publicação futura; npm ci não; pm2 restart marketplace-worker --update-env sim na publicação futura; migration sim, local revisada e não aplicada; dependências não. Publicação pendente, sem READY. Executar somente check:smart e deploy:smart -- --dry-run; execute/produção exige autorização futura.
