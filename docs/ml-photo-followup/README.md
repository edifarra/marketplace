# Confirmação assíncrona das fotografias do Mercado Livre

## Causa

Em lib/outgoing-activities.ts, updateAndConfirmListing fazia um GET imediato e até cinco GETs finais, separados por um segundo. Fotos ainda em processamento provocavam throw, diagnóstico por fotografia e requeue_outgoing_marketplace_activity. Essa RPC agenda imediatamente outra atualização e encerra em erro na quinta tentativa: a aceitação do PUT era confundida com conclusão das fotos.

## Correção

Somente listing_update do Mercado Livre com fotografias passa a usar a resposta válida do PUT como aceitação, sem esperar GETs de fotos. Rejeições HTTP e rejeições explícitas no corpo permanecem erros. A atividade concluída libera a tela com a mensagem exata: **Produto atualizado com sucesso. Fotos ainda em processamento pelo Mercado Livre.** Fotos prontas mantêm o sucesso normal.

A aceitação tem checkpoint persistente compacto, utilizado se uma etapa posterior precisar retomar a atividade. Não se prepara nem se repete o PUT de fotografias nessa retomada. Descrição e reativação continuam com seu tratamento existente.

O acompanhamento usa três campos na própria atividade: photo_confirmation (data da aceitação, fontes enviadas, IDs retornados, contador e resultado), photo_next_at e photo_lease_at. Não há nova tabela, timer em memória nem segunda rotina de polling. O worker captura verificações vencidas na chamada da fila que já existe. Elas conservam status completed e attempt_count; nunca passam pelo retry do PUT.

Prazos absolutos desde a aceitação: 30 segundos, 2 minutos, 10 minutos, 1 hora e 6 horas. O processamento ocorre no primeiro ciclo disponível após o vencimento, conforme a disponibilidade e a cadência já existente do worker. Não foram alterados seus intervalos de espera. A fila usa FOR UPDATE SKIP LOCKED e lease de dez minutos, recuperável após reinício; atualizações de resultado exigem o mesmo lease. Cada GET de fotos tem timeout de quinze segundos. Confirmação encerra antecipadamente; a quinta consulta sem confirmação encerra em unconfirmed, inclusive se o GET falhar.

Identidade: cada ID devolvido no PUT deve aparecer no GET, sem reutilizar um ID para representar fotos distintas. Na ausência de ID, exige-se correspondência explícita da fonte/URL enviada. Quantidade sozinha não confirma. URLs de processamento, ausência de URL final ou status de falha mantêm a pendência. Sem IDs/fontes que permitam comprovar identidade, encerra como não confirmado sem reenviar.

Os GETs solicitam somente id,pictures. Não persistem o JSON do anúncio nem novas cópias de suas fotografias. A captura de verificações também omite requested_data e previous_data na resposta, preservando-os no banco. As contas e os anúncios são os da atividade original, não o SKU.

## Impacto estimado

Para uma atualização sem descrição/reativação, o caso pendente passa de até cinco PUTs, trinta GETs de item e consultas adicionais de diagnóstico para um PUT e no máximo cinco GETs compactos. Fotos prontas não geram GET de acompanhamento. Esses números excluem chamadas OAuth e operações adicionais realmente solicitadas.

Supabase: nenhuma RPC adicional por ciclo ocioso. Um checkpoint adicional após a aceitação; por consulta executada, uma leitura da conta, uma atualização compacta da atividade e um registro compacto no histórico, além da captura já existente. Até cinco consultas por acompanhamento; a confirmação antecipada reduz esse total. Não foram alteradas políticas de reconciliação, estoque/preço, conversas, reclamações, webhooks, retries dos demais fluxos ou outros marketplaces.

## Validação

Testes de integração com fetch simulado cobrem PUT 200 pendente/pronto, ausência de GET imediato, primeira confirmação, cinco prazos absolutos, GET 503 sem PUT, rejeições 400 e rejeição explícita em 200, duas contas com o mesmo SKU, retomada com checkpoint, identidade divergente/duplicada e atualização sem fotos. Testes existentes verificam comparação de imagens e pós-processamento ML/Shopee/Tiny.

Teste SQL executa a migration em PostgreSQL local isolado (PGlite), verifica elegibilidade por prazo, ausência de segunda captura com lease ativo, recuperação de lease expirado, persistência exportada e reaberta após reinício, preservação do limite de tentativas do PUT e privilégios somente service_role. A RPC antiga de um argumento continua capturando apenas operações normais.

A compilação de produção local e a verificação de tipos foram validadas. Executar também check:smart e deploy:smart -- --dry-run após registrar o commit. Testes não consultam nem modificam ML/Supabase de produção.

## Publicação pendente de autorização

Migration necessária: 20261011222103_mercado_livre_picture_followup.sql. Aplicar primeiro no Supabase. A nova assinatura da RPC exige p_include_photos explícito; workers antigos continuam usando a assinatura anterior e não capturam fotografias.

Após autorização, publicar o plano Smart cumulativo desde o baseline de deploy confirmado, sem ocultar commits anteriores. Em seguida confirmar Vercel READY e atualizar o worker para o mesmo SHA. Esta tarefa não altera package.json/package-lock.json, portanto não exige npm ci por si só. Comandos da VPS, somente após a publicação autorizada:

```bash
cd /opt/gestao-marketplace
git pull origin main
pm2 restart marketplace-worker --update-env
pm2 status marketplace-worker
```

Não foi aplicado deploy, migration remota, push nem reinicialização da VPS. O caso histórico SKU 818PFD não foi reenviado ou modificado em produção.
