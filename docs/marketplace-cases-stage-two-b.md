# Central — Etapa 2B local

Listagem em quatro blocos, foto à esquerda e detalhe inline com uma expansão por vez. O detalhe é carregado sob demanda pela rota GET autenticada `/api/central-reclamacoes/[id]`. A rota direta reutiliza o mesmo componente.

Consulta: projeção compacta do Caso e vínculos existentes, produtos por SKU em lote, prazos da observação corrente com propósito conhecido, Timeline e Ações exclusivamente das tabelas estruturadas. Chat exige uma única conversa com marketplace, conta e pedido exatos. Mensagens locais são paginadas em blocos de 100 com cursor; nenhum snapshot técnico, activity, envio ou execução é carregado.

Validação real: 144 Casos únicos (100 ML e 44 Shopee), contas e paginação preservadas. ML 5587459753 / ML-ED e Shopee 2610040NPM7U341 / SP-ED carregaram os Gerais. Ambos sem conversa inequívoca, Timeline ou Ações; exibidos os estados vazios previstos. Histórico sem status, needs_action, motivo, descrição do comprador e reputação oficial: permanece desconhecido/Não informado. Produto deriva somente dos vínculos locais existentes com a venda e SKU.

Interface validada localmente: quatro colunas, expansão, troca de Caso, fechamento/reabertura, busca dos dois IDs, filtro Shopee e paginação. Testes de associação segura e reputação Shopee, mais regressões da listagem: 7 aprovados; typecheck aprovado. Leituras reais e API verificadas com guard de rede restrito a GET/HEAD do Supabase: nenhuma chamada ML/Shopee nem alteração dos Casos. Chat populado/rolagem de mensagens não pôde ser validado nesses dois Casos por ausência de conversa local segura.

Build aprovado, com avisos preexistentes de imagens em outras telas. Auditoria do servidor durante navegação: 71 leituras Supabase (50 GET, 21 HEAD), zero bloqueios e zero mutações.

Arquivos desta rodada: `app/central-reclamacoes/page.tsx`, `cases.module.css`, `[id]/page.tsx`, `case-grid.tsx`, `case-display.ts`; `app/api/central-reclamacoes/[id]/route.ts`; `lib/marketplace-case-list.ts` (exportação da projeção compartilhada), `lib/marketplace-case-detail.ts`; `tests/marketplace-case-detail.test.ts`; `scripts/validate-marketplace-case-detail.ts`, `scripts/validate-marketplace-case-list.ts` (expectativa da rota direta atualizada); este relatório.

Sem commit, deploy, migration ou alteração de VPS. Impacta Vercel: sim, em eventual publicação futura. Impacta worker/VPS: não. Precisa git pull na VPS, npm ci ou PM2 restart: não. Hash de commit: não criado por instrução desta etapa.
