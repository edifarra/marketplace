# Central de Reclamações e Devoluções — Etapa 2A

Entrega exclusivamente local, somente leitura, em `/central-reclamacoes`, acessível pelo menu lateral. Uma linha por identidade persistida do Caso; 30 Casos por página. O destino `/central-reclamacoes/[id]` apenas identifica o Caso e informa que o detalhamento pertence a uma próxima etapa.

## Consulta e crescimento

`lib/marketplace-case-list.ts` usa somente SELECT/HEAD no Supabase administrativo, no servidor. Não importa clientes de marketplace, orquestradores, enrichment ou reconciliação.

- Projeção explícita de campos pequenos de `marketplace_cases`, com relações locais de conta, venda, item e produto. Não lê activities, timeline, ações, evidências, snapshots ou `raw_data` de vendas/itens.
- Sem busca: quatro contagens por grupos disjuntos e leitura apenas dos intervalos necessários para compor a página. Ordem: ação oficial, andamento conhecido, desconhecidos, encerrados; dentro do grupo, `updated_at` local decrescente, com desempate por ID.
- Com busca: filtros sobre os IDs externos, pedidos, SKUs e títulos persistidos. Títulos do catálogo são resolvidos para SKUs exatos dos itens de vendas já vinculadas. Requisições são paginadas e SKUs divididos em lotes de 60 para não ultrapassar o tamanho de URL. Apenas identidades/estado/data dos resultados correspondentes são agregados e deduplicados antes da contagem/ordenação/paginação. A projeção completa é lida somente para os até 30 Casos visíveis. Buscas amplas têm custo proporcional aos SKUs/resultados correspondentes; não há migration ou índice novo nesta etapa.
- Produtos e imagens dos itens da página são lidos em lotes de até 100 SKUs. Nenhuma consulta individual por Caso.
- Prazos: uma consulta em lote às observações com o timestamp exato do snapshot persistido, lendo somente metadados e deadlines. Sem snapshots. Usa a observação mais recentemente recebida nesse timestamp; observações posteriores apenas de identidade não substituem o prazo do snapshot retido. Finalidade desconhecida, precisão desconhecida e deadline fora do snapshot atual são omitidos.
- `needs_action=NULL` permanece NULL. Abertura não implica ação. Status não reconhecidos permanecem desconhecidos. Reputação Shopee permanece não informada, inclusive se houver um valor incoerente no campo persistido.

Os produtos associados por SKU aos itens da venda são contexto da **venda**, identificados expressamente como “Itens da venda · item do Caso não identificado”. Não se escolhe um item da venda como afetado pelo Caso. Um vínculo explícito com item/produto do Caso é mostrado quando existe e é consistente.

Miniaturas usam somente imagens já persistidas no catálogo, em `/uploads/` ou Cloudinary. Sem recuperação de imagens, proxy de venda ou acesso aos hosts de imagem dos marketplaces. Ausência é mostrada como “Sem foto”.

O componente de notificações global existente é desativado somente nas rotas da Central, evitando seu polling e suas notificações nesta tela. Comportamento das demais rotas preservado. Sidebar recebe apenas o novo item, sem redesenho.

## Validação

- 21 testes passaram: cinco novos de classificação, vínculos e deadlines, mais os 16 testes existentes da Etapa 1.
- Typecheck e build passaram. Avisos de `<img>` permanecem nos componentes existentes; a página nova usa imagens sem otimização/proxy.
- Aplicação executada localmente, com sessão autenticada e Supabase existente. Foram verificados HTTP e interface: menu, listagem, busca dos dois Casos exigidos, conta, marketplace, aba de ação e destino básico.
- 144 Casos únicos, em cinco páginas: 100 Mercado Livre e 44 Shopee. Nenhuma duplicação de ID ou identidade de negócio.
- Contas: ML-ED 54, ML-GI 46, SP-ED 27, SP-GI 17. Conta e marketplace conferem com a FK persistida de cada Caso.
- Mercado Livre `5587459753`: ML-ED, venda `2000018642386506`.
- Shopee `2610040NPM7U341`: SP-ED, venda `261002GMURC6QX`.
- Busca por SKU `1012PP.151225` e por número de venda passaram; busca ampla “Placa” retornou 112 Casos sem duplicação, com 30 na página. Caracteres especiais, ausência de resultado e página inválida também passaram.
- Os 144 históricos não têm status, necessidade de ação, motivo/descrição do comprador ou timestamp oficial. Reputação é desconhecida nos 144; não há deadlines. Não há vínculo direto com item/produto/listing; os 144 têm venda vinculada. A interface usa “Não informado”, “Não informada” ou “—”, e distingue a atualização local da oficial. Todos permanecem em Todos como desconhecidos/incompletos; as outras três abas têm zero.
- O script de validação bloqueia hosts externos e métodos de escrita. Um preload separado foi usado no servidor local para auditar/bloquear saídas: somente GET/HEAD no REST do Supabase, incluindo as leituras habituais de autenticação e Sidebar; zero chamadas ML/Shopee, zero tentativas bloqueadas e zero gravações. Os `updated_at` dos Casos permaneceram idênticos antes/depois.

Comandos reproduzíveis (não executam consolidação/migration/deploy):

```powershell
node --import tsx --require ./scripts/register-server-only.cjs --test tests/marketplace-case-list.test.ts tests/marketplace-cases.test.ts
npm run typecheck
npm run build
$env:CASE_LOCAL_URL = 'http://localhost:3000'
node --env-file=.env.local --import tsx --require ./scripts/register-server-only.cjs scripts/validate-marketplace-case-list.ts
```

Preload opcional para o servidor local auditado, nunca carregado em produção:

```powershell
$env:CASE_READ_AUDIT_FILE = Join-Path $env:TEMP 'central-case-read-audit.jsonl'
node --env-file=.env.local --require ./scripts/guard-marketplace-case-reads.cjs ./node_modules/next/dist/bin/next dev -p 3000
```

## Arquivos e implantação

Criados: `app/central-reclamacoes/page.tsx`, `app/central-reclamacoes/cases.module.css`, `app/central-reclamacoes/[id]/page.tsx`, `lib/marketplace-case-list.ts`, `tests/marketplace-case-list.test.ts`, `scripts/validate-marketplace-case-list.ts`, `scripts/guard-marketplace-case-reads.cjs`, este relatório.

Alterados: `app/components/sidebar-navigation.tsx`, `app/components/global-marketplace-notifications.tsx`.

Impacta Vercel? **Sim, em futura publicação da interface**. Impacta o worker da VPS? **Não**. Precisa `git pull` na VPS? **Não**. Precisa `npm ci`? **Não**. Precisa `pm2 restart marketplace-worker --update-env`? **Não**.

Sem commit (não há hash), deploy, alteração VPS, PM2, instalação de dependências, migration, consolidação ou alteração de Casos. Não há deploy READY: a entrega solicitada é local para revisão.
