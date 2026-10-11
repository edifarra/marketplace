# Histórico anterior do Chat em reclamações ML

## Causa e solução

A descoberta por unread e conversas pendentes não encontra chats respondidos ausentes do banco. O enriquecimento de reclamações agora aproveita o pedido já validado por seller e comprador, recuperando seu pós-venda pelo pack oficial do pedido ou pelo próprio order_id. Reutiliza o cliente com mark_as_read=false, a normalização e a persistência/deduplicação existentes. Não altera a descoberta geral nem faz varredura de pedidos.

Novos eventos e a reconciliação existente dos casos abertos executam o mesmo enriquecimento. Isso atende reclamações existentes sem depender de abrir o detalhe na interface. Falhas opcionais de histórico não impedem o processamento da reclamação.

## Cache e isolamento

Reutiliza settings (key/value JSONB), com uma chave por conta/pedido. Registra tentativa, resultado, cobertura e retentativa. Sucesso que cobre a abertura da reclamação dispensa novas chamadas para esse histórico imutável. Outra reclamação posterior ao período coberto permite atualizar. Falhas transitórias aguardam 15 minutos; 404 aguarda uma hora, como o cache negativo de resolução de packs, sem concluir ausência definitiva. Uma aquisição compare-and-set e identificador do executor evitam consultas simultâneas redundantes e conclusão por outro executor. Se o processo parar, a aquisição expira em 15 minutos.

O vínculo usa o pedido retornado pela API e a conta validada do seller. Mensagens com seller, pack ou pedido incompatível são rejeitadas. Não há nova migration nem alteração dos intervalos de 15/15/60 minutos ou polling de 30 segundos. As leituras da Central continuam locais.

## Apresentação e anexos

O detalhe lê a conversa pós-venda da mesma conta/pedido, de forma conservadora: vínculos ambíguos não são exibidos. Seleciona somente mensagens anteriores ao claim_created_at oficial, ordena cronologicamente e deduplica IDs oficiais. Preserva separadamente messages/conversation do canal claim. ClaimControls continua enviando exclusivamente pelo canal da reclamação.

A seção Histórico anterior do Chat é somente leitura e só aparece com mensagens. Mantém texto completo, direção, data, tipo e raw_data. Imagens e arquivos reutilizam o proxy autenticado de anexos, com a conta da conversa. Mensagens sem texto continuam presentes, mesmo quando não existe anexo visualizável. Datas usam America/Sao_Paulo.

## Validação

- Testes com mocks: pedido sem pack distinto, pack distinto, chat respondido ausente do banco/unread, cache de chat já persistido, replay idempotente, isolamento, concorrência, imagem com texto vazio, 404, 503, falha opcional no bundle, corte cronológico/deduplicação e preservação do canal oficial.
- Regressões: resolução de pack, separação chat/case, operações oficiais de reclamação e detalhe do caso.
- Build de produção e TypeScript.
- Script scripts/validate-claim-chat-history-readonly.ts: bloqueia requisições que não sejam GET/HEAD; lê token armazenado sem refresh; verifica o caso 5592119231 e normaliza somente em memória. Confirmadas seis mensagens anteriores do pedido 2000018889505456, ML-GI/seller 181345701. A mensagem de 10/10/2026 17:25:57 UTC contém imagem JPEG. Nenhuma gravação em produção.

## Publicação e limites

Publicação seletiva exige Vercel e worker VPS, sem npm ci porque dependências não mudaram. Sem migrations. Após autorização, usar deploy:smart -- --execute sobre o commit validado e seguir o plano cumulativo emitido pelo dry-run (que pode conter alterações anteriores ao commit desta tarefa). Na VPS, atualizar main e reiniciar marketplace-worker com --update-env; confirmar seu status.

A confirmação de persistência real das seis mensagens e visualização na produção fica pendente da publicação e primeira reconciliação. Não executar backfill, deploy, migrations ou atualização da VPS como teste. Cache em settings cresce apenas por pedidos com reclamações; não varre todos os pedidos. Histórico com vínculo ambíguo ou data de abertura ausente é omitido para evitar associação incorreta. Anexos dependem de credenciais válidas e disponibilidade do Mercado Livre.
