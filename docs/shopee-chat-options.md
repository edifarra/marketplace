# Gerenciamento oficial dos chats Shopee

Menu circular de três pontos no final do cabeçalho de cada chat Shopee, com **Marcar como lido** e **Excluir chat**. Ambas as ações são enfileiradas e executadas pelo worker com a conta da conversa. Não há silenciamento local nem exclusão simulada. A tela conserva o estado enquanto aguarda confirmação; a fila registra operador, tentativas, recibo e erros.

## Contratos e limites da investigação — 05/10/2026

- POST `/api/v2/sellerchat/delete_conversation`: `conversation_id` (int64).
- POST `/api/v2/sellerchat/read_conversation`: `conversation_id` (int64), `last_read_message_id` (string).
- As referências oficiais são https://open.shopee.com/documents?module=109&type=1&id=675&version=2 e https://open.shopee.com/documents?module=109&type=1&id=679&version=2. O portal oficial não expôs conteúdo nesta sessão, inclusive no navegador.
- Os contratos implementados foram cruzados com o código dos clientes públicos: https://github.com/JimCurryWang/python-shopee/blob/master/pyshopee2/chat.py e https://pkg.go.dev/github.com/wjpxxx/shopeego/sellerchat/entity#ReadConversationRequest. Essas referências não confirmam as permissões do aplicativo/loja atual. Uma recusa da API aparece como erro, nunca como ação concluída.
- O guia oficial de Webchat confirma o gerenciamento individual de conversas: https://cdngarenanow-a.akamaihd.net/shopee/seller/seller_cms/c467b10191494f4269ffd462f9a7ddcb/Webchat%20User%20Guide.pdf.
- Marcar como lido altera leitura, não envia resposta e não dispensa a obrigação de responder nem comprova efeito em métricas Shopee. `requires_response` e o vermelho de pendência de resposta são preservados. A identificação Lida/Não lida aparece no detalhe. Nenhuma operação oficial de mute foi confirmada.

## Fila, confirmação e sincronização

A RPC administrativa `enqueue_shopee_conversation_action` valida operador ativo, conta ativa, tipo Shopee e ID da última mensagem mostrado na tela. O bloqueio da linha e o índice único impedem ações simultâneas para o mesmo chat; cliques repetidos na mesma ação reutilizam a fila pendente. Não existe chamada à Shopee pelo navegador.

O worker despacha `conversation_read` e `conversation_delete`. Um POST bem-sucedido precisa retornar um recibo com `request_id` e `response`. Esse recibo é persistido antes de finalizar o estado interno; um retry após falha local reaproveita o recibo e não repete o POST. Recusas de permissão não modificam leitura, pendência nem mensagens. O status é acompanhado pela tela e por Atividades Enviadas.

A leitura usa a mensagem capturada ao enfileirar, sem consumir mensagens que chegaram depois. IDs são preservados sem conversão a Number; o conversation_id numérico é serializado com todos os dígitos. Contagem de não lidas informada pela Shopee tem prioridade sobre a heurística de direção na sincronização. O banco protege marcadores de leitura e IDs contra snapshots atrasados.

A exclusão exige confirmação do usuário no menu e consulta a conversa antes do POST. Se houver mensagem mais nova, a ação termina em erro e pede atualização da tela. Depois do recibo, `shopee_deleted_at` remove a conversa da página, contagens, indicador global de pendências e atualizações incrementais, preservando histórico interno. Uma nova mensagem com ID posterior reabre a conversa. Uma exclusão cujo retorno HTTP/recibo se perder não é tratada automaticamente como sucesso: a fila mantém o erro para investigação. Existe uma janela inevitável entre a consulta prévia e o POST de exclusão, pois o contrato não inclui exclusão condicional por mensagem.

## Migration e acesso

`20261005202737_shopee_chat_management_queue.sql` amplia o check dos tipos de atividade, adiciona marcadores do chat, índice de fila, trigger de proteção e RPCs service only. Atualiza a RPC de paginação para excluir chats com exclusão remota confirmada. Faz backfill **somente dos IDs de mensagens já persistidas**, sem consultar marketplaces. Não apaga linhas ou mensagens, não cria política pública e não muda dependências.

## Validação e publicação

Testes com transporte simulado exercitam o executor e o dispatcher reais do worker, endpoints/payloads, permissões, confirmação, retry e divergência de conta. PostgreSQL isolado executa as migrations e valida filas, deduplicação, ACLs, preservação de mensagens e concorrência com snapshots atrasados. Não foram feitas chamadas de escrita em uma conversa real.

Impactos: Vercel **sim**, worker/VPS **sim**, migration **sim**, `git pull` na VPS **sim**, `npm ci` **não**, `pm2 restart marketplace-worker --update-env` **sim**.

Fluxo solicitado:

```sh
npm run check:smart
npm run deploy:smart -- --dry-run
# Somente para publicar, depois de resolver o deploy anterior pendente:
npm run deploy:smart -- --execute
```

A publicação deve aplicar/confirmar a migration antes do push, confirmar Vercel READY e atualizar/reiniciar o worker. Há um journal anterior `.smart-deploy-progress.json` com target `18036ac978aa418bf40cfcabac6a34ff27e74bbe`, migration e push registrados, mas sem conclusão. O smart não admite substituir esse target por uma alteração que envolve migration/worker. O registro anterior foi preservado. Não declarar produção concluída sem resolver essa pendência e confirmar as três etapas.
