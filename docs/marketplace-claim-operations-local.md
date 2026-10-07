# Central: operações de reclamações Mercado Livre

Entrega local. Nenhuma migration remota, publicação, atualização da VPS ou ação real de reembolso, devolução ou mensagem foi executada.

## Comportamento

- Cabeçalho com caso secundário, motivo humano, reputação oficial e prazo vigente do vendedor em vermelho/negrito, no fuso de Brasília.
- Conversa separada por conta e reclamação, sem reutilizar chat pós-venda do pedido. Preserva mensagem pessoal, moderação e metadados dos anexos.
- Dados fiscais vêm do pedido/billing-info oficial; dados logísticos permanecem separados. Link do comprador filtra conta, marketplace, comprador e site.
- Timeline usa datas oficiais, identidade estável e eventos de venda, reclamação e logística reversa. Consulta histórica de ações não habilita botões atuais.
- Reembolso total, oferta parcial, devolução e mensagem exigem confirmação e capacidades oficiais atuais. Abrir disputa permanece somente orientação de mediação.
- Ofertas parciais são consultadas apenas após interação explícita e novamente na validação da oferta escolhida. Nenhuma seleção inicial automática.

## Execução e confirmação

A fila existente `outgoing_marketplace_activities` recebe `claim_action`. Uma operação equivalente é deduplicada; outra operação fica bloqueada enquanto houver resultado pendente. O worker revalida identidade, operador, capacidade, prazo, revisão, produto, moeda e valores antes de enviar.

A barreira persistida `sending` antecede o único POST. Timeout ou falha de persistência após envio mantém resultado incerto: tentativas seguintes consultam e confirmam, sem repetir POST. A interface só anuncia sucesso depois de evidência oficial e persistência local. Uma operação incerta sem evidência permanece pendente.

O ciclo de segurança já existente do worker reconcilia operações pendentes e reclamações abertas em lotes limitados. Listagem, expansão e consulta de progresso usam dados locais; não consultam ofertas. Não foi criada outra fila ou rotina de backfill.

POSTs implementados, testados com respostas sintéticas:

| Ação | Endpoint relativo a `/post-purchase/v1/claims/{id}` | Corpo |
|---|---|---|
| Reembolso total | `/expected-resolutions/refund` | Sem corpo |
| Oferta parcial | `/expected-resolutions/partial-refund` | `percentage` selecionado |
| Devolução | `/expected-resolutions/allow-return` | Sem corpo |
| Mensagem | `/actions/send-message` | `receiver_role: complainant`, `message` |

## Banco e publicação futura

Migration local: `supabase/migrations/20261007170807_marketplace_claim_operations.sql`. Estende tabelas existentes, permissões, deduplicação e funções transacionais; não cria nova fila.

Impactos: Vercel e worker da VPS. Não altera dependências. Uma publicação futura deve aplicar a migration antes da aplicação, publicar a Vercel e atualizar/reiniciar o worker. O dry-run é somente um plano e não comprova publicação.

## Validação

Testes de domínio, executor com respostas sintéticas, contratos de leitura e SQL isolado cobrem concorrência, duplicação, timeout, falha local após envio, mudanças de oferta/capacidade, autorização, isolamento de chat, cronologia e metadados. Não substituem homologação dos POSTs com o Mercado Livre, que não foi autorizada nesta tarefa.

## Arquivos alterados

- `app/api/central-reclamacoes/[id]/actions/route.ts`
- `app/api/central-reclamacoes/[id]/operations/[operationId]/route.ts`
- `app/central-reclamacoes/case-display.ts`
- `app/central-reclamacoes/case-grid.tsx`
- `app/central-reclamacoes/cases.module.css`
- `app/central-reclamacoes/claim-controls.tsx`
- `app/central-reclamacoes/page.tsx`
- `lib/marketplace-case-detail.ts`
- `lib/marketplace-case-domain.ts`
- `lib/marketplace-case-enrichment.ts`
- `lib/marketplace-case-list.ts`
- `lib/marketplace-claim-domain.ts`
- `lib/marketplace-claim-operations.ts`
- `lib/marketplace-claim-service.ts`
- `lib/marketplace-claim-timeline.ts`
- `lib/outgoing-activities.ts`
- `scripts/marketplace-worker.ts`
- `supabase/migrations/20261007170807_marketplace_claim_operations.sql`
- `tests/marketplace-case-detail.test.ts`
- `tests/marketplace-cases-sql.test.mjs`
- `tests/marketplace-claim-operations.test.ts`
- `docs/marketplace-claim-operations-local.md`
