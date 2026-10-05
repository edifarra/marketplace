# Central: contexto e atenção operacional

Implementação local de 05/10/2026. Publicação deliberadamente não executada, conforme a tarefa específica.

## Diagnóstico e reaproveitamento

O schema existente já oferece `case_type`, `needs_action`, `responsible`, `content`, `reverse_logistics`, observações, timeline, ações, evidências e prazos com `purpose`/`responsible`. A função `persist_marketplace_case(jsonb)` mescla conteúdo e logística e preserva as observações anteriores. Não foi necessário alterar tabelas ou a função SQL, nem criar migration.

A normalização anterior não aproveitava entidades relacionadas do ML, identificação logística ou os prazos e follow-ups do vendedor na Shopee. A tela tinha somente guias de situação e não possuía alerta próprio de reclamações na navegação.

## Regras implementadas

- Contexto Devolução: `case_type=return`, `reverse_logistics.entity_created=true`, `reverse_logistics.return_id` ou `reverse_logistics.tracking` efetivamente persistido. Nos demais casos permanece Reclamação. Intenção/solução solicitada não participa.
- No ML, `related_entities` contendo `return` é evidência oficial da associação. Referência: [documentação de devoluções](https://developers.mercadolivre.com.br/pt_br/relatorios-de-faturamento/gerenciar-devolucoes).
- `ACTION_REQUIRED`: caso não encerrado com `needs_action=true`. `MONITORING`: demais casos. `NULL` não vira obrigação e continua identificado como informação ausente na apresentação.
- Para novos eventos, ações obrigatórias persistidas marcam atenção. A Shopee também reconhece `return_seller_due_date`, `seller_evidence_deadline` e evidência do vendedor `PENDING`; nunca utiliza `return_ship_due_date` ou `due_date` genérico como obrigação do vendedor.
- Follow-ups desconhecidos são conservados como capacidades observadas, sem inventar obrigatoriedade. Objetos com responsável vendedor e obrigatoriedade explícita podem marcar atenção. `validation_type` e `negotiation_status` isoladamente não criam obrigação.
- Bolinha global: exclusivamente Reclamação + `ACTION_REQUIRED`. Devoluções nunca entram, inclusive aquelas com ação obrigatória. Encerrados suprimem flags antigas.
- A reclamação com entidade de devolução passa para a guia Devoluções sem mudar sua identidade de persistência: mantém `case_type=claim`, ID interno, observações, chat e timeline. `content.related_claim_id` registra o ID externo original; a logística registra o ID de retorno quando informado. Não se relacionam casos apenas pelo pedido ou pelo comprador.
- Prazos do comprador, vendedor, evidência, validação, logística e encerramento automático têm rótulos com finalidade e responsável. O detalhe também apresenta prazo de finalidade desconhecida como tal. Somente prazos da observação correspondente ao snapshot atual são apresentados.

## Busca e apresentação

Uma única busca pesquisa SKU, título de produto, pedido/venda, ID externo do caso, ID da devolução associada, nome comercial disponível na conversa/conteúdo, `reverse_logistics.contact_name` e `reverse_logistics.tracking`.

O nome logístico usa `reverse_logistics.contact_name`, a partir de nome explicitamente fornecido na logística, remetente/destinatário da logística reversa ou campos explícitos `return_contact_name`/`reverse_logistics_contact_name`. Nunca copia `buyer_name` para esse campo. Ausência permanece `NULL` / Não informado.

O código de retorno usa o campo genérico existente `reverse_logistics.tracking`; a transportadora usa `reverse_logistics.carrier`. A normalização admite tracking explicitamente fornecido pelo fluxo de retorno, sem utilizar rastreio de venda/envio normal.

Mantidos os quatro blocos da linha, imagem à esquerda, accordion único, duas colunas, chat limitado com scroll, timeline de fatos persistidos e ações somente leitura. O detalhe acrescenta vínculo original, identificação logística, transportadora, modalidade/ponto, validação, negociação e evidências persistidas.

As consultas de contexto são locais ao banco, paginadas e sem N+1. Listagem não carrega timeline/chat/evidências completos. A busca ampla usa projeções compactas e deduplicação antes da paginação. Dados pesados continuam carregados ao expandir o caso.

## Histórico, testes e limites

Nenhum registro histórico foi alterado ou enriquecido nesta tarefa. A leitura aplica classificação conservadora aos campos já persistidos. Informações ausentes permanecem ausentes. Não houve backfill externo nem consulta a APIs ML/Shopee para preencher histórico.

`tests/marketplace-case-context.test.ts` cobre os 18 cenários solicitados, separação de contexto/atenção, busca, campos ausentes, encerrados e composição dos filtros. As buscas usam o cliente Supabase real com transporte HTTP em memória, sem rede. O teste SQL adicional executa a migration já existente num PostgreSQL isolado em PGlite, validando transição, identidade, histórico, prazos e retenção de logística em pushes parciais.

O validador da listagem histórica foi ajustado para as duas guias, mas não foi executado contra banco remoto. Os testes não consultam uma instância real do PostgREST ou os 144 registros de produção. Isso limita a verificação de integração com os dados reais, sem impedir a verificação local da lógica e da persistência.

Validação obrigatória: `npm run check:smart`, que executa testes relacionados, TypeScript e build Next.js. Avisos preexistentes de `<img>` não são falhas. Resultado e hash do commit constam na entrega no chat.

Durante os testes, nenhum request real aos marketplaces ou banco remoto foi realizado; chamadas simuladas são atendidas em memória e o PostgreSQL de teste é isolado. A documentação pública foi consultada durante a implementação, separadamente dos testes.

## Arquivos alterados

- `app/central-reclamacoes/page.tsx`
- `app/central-reclamacoes/case-grid.tsx`
- `app/central-reclamacoes/case-display.ts`
- `app/components/sidebar.tsx`
- `app/components/sidebar-navigation.tsx`
- `lib/marketplace-case-context.ts`
- `lib/marketplace-case-domain.ts`
- `lib/marketplace-case-list.ts`
- `lib/marketplace-case-detail.ts`
- `scripts/validate-marketplace-case-list.ts`
- `tests/marketplace-case-context.test.ts`
- `tests/marketplace-cases-sql.test.mjs`
- `docs/marketplace-cases-context-attention.md`

## Publicação futura, não executada

Impacta Vercel: Sim. Impacta worker/VPS: Sim, pela normalização compartilhada. Precisa `git pull` na VPS: Sim. Precisa `npm ci`: Não, dependências inalteradas. Precisa `pm2 restart marketplace-worker --update-env`: Sim. Alteração de schema/migration: Não; apenas novos valores nos JSONs existentes para eventos futuros.

Em uma tarefa futura autorizada, enviar o commit ao repositório remoto, publicar a aplicação na Vercel e confirmar READY. Na VPS, após o commit estar disponível em `main`:

```bash
cd /opt/gestao-marketplace
git pull origin main
pm2 restart marketplace-worker --update-env
pm2 status marketplace-worker
```

Não executar migrations, backfill ou instalação de dependências para esta alteração. Nenhum desses passos de publicação foi executado nesta tarefa.
