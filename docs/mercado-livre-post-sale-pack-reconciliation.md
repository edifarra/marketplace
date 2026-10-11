# Reconciliação de packs pós-venda — 11/10/2026

## Causa e frequência

O fallback selecionava `venda.pack_id`, coluna inexistente (confirmado no esquema de produção). Também não filtrava a conta e usava `limit(1)`, ocultando ambiguidades. O resolvedor capturava qualquer erro remoto e selecionava o primeiro pedido remoto quando o fallback falhava.

Cada notificação ou item não lido sem `order_id` voltava a consultar `/packs/{id}`. Não havia TTL ou deduplicação entre essas tentativas. A leitura por caminho e a reconciliação dos não lidos também carregavam o mesmo detalhe de conversa duas vezes. Esta análise identifica os pontos de repetição no código; não mede o volume histórico de chamadas na VPS.

## Correção

- Busca local primeiro: `order_id`, `raw_data.payload.order.pack_id` e `raw_data.payload.shipment.pack_id`, sempre com `raw_data.marketplace_account_id` e marketplace Mercado Livre.
- Três consultas limitadas a dois resultados cada, executadas juntas. A união dos pedidos detecta ambiguidades inclusive entre fontes diferentes; nenhum pedido é escolhido arbitrariamente.
- Somente HTTP 404 entra no cache negativo em memória, por conta e pack, por uma hora. Até 1.000 entradas; requisições simultâneas compartilham a mesma tentativa remota. Erros 401/403/429/5xx e de rede continuam propagando para o tratamento existente.
- O status HTTP é preservado por `mlGet`, mesmo com corpo de erro vazio ou inválido.
- A busca local continua durante o TTL, permitindo recuperação assim que a venda é importada. `clear()` permite invalidar o cache; reiniciar o processo também o limpa. O cache não é compartilhado entre processos/Vercel e não sobrevive a reinícios.
- Conversas sem pedido continuam sendo persistidas. Uma falha posterior de resolução não apaga um vínculo existente.
- A rotação existente de conversas pendentes pode preencher somente o vínculo ausente, mesmo sem alteração nas mensagens. A reparação usa compare-and-set (`order_id IS NULL`, conta, pack, ID, marketplace e tipo) e registra os vínculos em log.
- O detalhe de uma conversa já carregada é reutilizado. Não foram alterados fila, worker, agendamento de 15 minutos ou dependências. Não há novo job recorrente.

## Auditoria e reparação autorizável

O conector Supabase e o reparador usando os filtros REST reais confirmaram seis associações únicas, quatro por igualdade com o pedido e duas pelo JSON. O relatório `mercado-livre-post-sale-orders-audit-2026-10-11.jsonl` contém IDs, contas, packs, pedidos e `applied: false`. Nenhuma escrita foi realizada no Supabase.

Somente leitura, criando um relatório novo (não sobrescreve arquivos):

```powershell
npx tsx scripts/repair-mercado-livre-post-sale-orders.ts --report=auditoria-ml-packs.jsonl
```

Após autorização explícita para a alteração real:

```powershell
npx tsx scripts/repair-mercado-livre-post-sale-orders.ts --apply --report=reparo-ml-packs.jsonl
```

O reparador revalida as associações atuais; não usa IDs/pedidos congelados nesta auditoria. Pagina por ID, altera apenas `order_id`, não modifica mensagens/status/histórico e registra intenção e resultado de cada tentativa. Uma segunda execução ignora vínculos preenchidos. O relatório usa JSON Lines. Os logs e relatórios guardam a auditoria fora do histórico da conversa. Não há migration de esquema necessária.

## Validação

Os testes usam o query builder Supabase real com respostas REST controladas e rejeitam colunas desconhecidas. Cobrem os três caminhos locais, números no JSON, inexistência, isolamento de contas, ambiguidades, 404, falhas temporárias/autenticação/rede, deduplicação, TTL, limpeza, recuperação local, persistência sem pedido e preservação de mensagens/vínculo.

```powershell
node scripts/smart-test-runner.mjs tests/mercado-livre-pack-resolution.test.ts tests/mercado-livre-pack-persistence.test.ts tests/marketplace-special-messages.test.ts
npm run test:ml-post-sale
npm run build
npm run check:smart
npm run deploy:smart -- --dry-run
```

Entrega preparada localmente: publicação Vercel, atualização VPS e reparação real permanecem pendentes de autorização. Dependências não mudaram; após publicação do commit, a VPS requer `git pull origin main` e `pm2 restart marketplace-worker --update-env`, seguidos de `pm2 status marketplace-worker`.
