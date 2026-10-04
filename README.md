# Sistema de estoque e marketplaces

Base Next.js + Supabase para substituir Google Sheets, Apps Script e Tiny ERP no fluxo de fotos, produtos, estoque e anuncios.

## O que ja esta modelado

- Coleta de fotos do Google Drive.
- Validacao do padrao de nomes usado no Apps Script.
- Agrupamento de fotos por produto.
- Busca de tipo, marca, especial, preco e categorias em tabelas Supabase.
- Geracao de SKU por grupo.
- Criacao do produto no sistema.
- Fila de publicacao para Mercado Livre e Shopee.
- Webhooks de venda para baixar estoque.
- Sincronizacao de estoque nos demais marketplaces.
- Pausa automatica de anuncios quando o estoque chega a zero.
- Telas de configuracao para substituir as abas da planilha.

## Como rodar

1. Preencha `.env.local` usando `.env.example`.
2. Crie o banco no Supabase com `supabase/migrations/001_schema.sql`.
3. Carregue dados iniciais com `supabase/seed.sql`.
4. Instale dependencias e rode:

```bash
npm install
npm run dev
```

## Rotas principais

- `/` painel operacional e configuracoes.
- `/api/pipeline/run` executa coleta/processamento em lotes.
- `/api/webhooks/mercado-livre` recebe eventos de venda do Mercado Livre.
- `/api/webhooks/shopee` recebe eventos de venda da Shopee.

## Observacao importante

Os conectores de Mercado Livre e Shopee estao isolados em `lib/marketplaces.ts`. Eles ja deixam claro onde criar, atualizar estoque e pausar anuncios. Para producao, complete a assinatura OAuth/assinatura HMAC conforme as credenciais da conta e valide em ambiente sandbox antes de ativar vendas reais.
# Deploy inteligente: ordem e recuperação

`npm run deploy:smart -- --dry-run --base=<SHA>` apenas lê dados locais. Mesmo com
`--execute --yes`, dry-run não faz fetch, chamadas de API, migration, push, SSH ou
escrita de estado. O plano informa que a situação remota não foi verificada.

Para executar, é necessário estar em `main`, com árvore limpa, ferramentas já
instaladas e baseline ancestral do alvo e de `origin/main`. O commit alvo precisa
conter exatamente um trailer `Smart-Deploy-Base: <SHA completo do baseline>`.
Exemplo ao criar um novo commit (não altera commits já publicados):

```bash
git commit -m "Descrição da alteração" --trailer "Smart-Deploy-Base: <SHA completo>"
npm run deploy:smart -- --execute --base=<mesmo SHA>
```

O baseline padrão vem de `.smart-deploy-state.json`; `--base` e
`SMART_DEPLOY_BASE` podem selecioná-lo explicitamente, mas precisam corresponder
ao trailer. Nenhum push deve ser feito antes de executar o fluxo com migration.
`--yes` não elimina a entrada obrigatória `DEPLOY`.

O script congela o SHA, classifica o intervalo inteiro, valida testes relacionados,
tipos e build frontend, atualiza/revalida o remoto e exige confirmação. Migrations
são somente adições: editar, renomear ou remover migrations existentes é bloqueado.
Quando necessárias, consulta o histórico, aplica `supabase db push --linked` e
confirma todas as versões locais no histórico remoto antes do push normal do SHA.
Histórico desconhecido ou divergente bloqueia o push. Os comandos Supabase usam
`npx --no-install`: instale previamente a CLI e vincule o projeto correto.

Não há force push, merge ou rebase automático. Branch remota atrasada em relação
ao alvo é permitida apenas por ancestralidade; branch local atrasada ou divergente
é bloqueada. O push normal também rejeita corridas incompatíveis. Após o push,
o SHA remoto deve ser exatamente o alvo.

Quando frontend=true, a integração Git da Vercel publica o commit; o script não
cria deployment manual. Requer `.vercel/project.json`, `VERCEL_TOKEN` no ambiente
e integração com production branch `main`. A API somente de leitura é consultada
por projeto, ambiente production e SHA; exige `READY` e confirmação do alias de
produção. Erro, cancelamento, bloqueio, falha de API ou timeout de 20 minutos
interrompem o fluxo antes da VPS e preservam o baseline.

`vercel.json` usa `node scripts/smart-vercel-ignore.mjs` como `ignoreCommand`.
Esse script usa o mesmo `classifyRange`/`classifyChanges` e o mesmo trailer,
incluindo todos os commits desde o baseline. Frontend=false retorna 0 e ignora o
build; frontend=true retorna 1 e permite o build. Em clone raso, tenta obter o
histórico. Trailer ausente, inválido ou histórico indisponível bloqueiam o build
(retorno 0), nunca autorizam publicação por suposição. Isso também afeta previews:
commits sem trailer não são construídos. Falhas da regra precisam ser corrigidas
antes de uma nova tentativa. A Vercel pode criar um registro cancelado/ignorado,
mas não publica um novo frontend. Não se usa `HEAD^` como segunda fonte de verdade.

Worker=false nunca usa SSH/PM2/npm ci. Worker=true verifica árvore limpa, branch
main e ancestralidade na VPS, exige origin/main no SHA alvo, avança a branch usando
`git reset --keep <SHA>` após a prova de fast-forward e confirma o SHA antes e depois
do restart. Esse comando preserva arquivos locais e não faz merge, rebase ou reset
hard. `npm ci` ocorre somente com worker=true e dependencies=true. PM2 deve indicar
marketplace-worker online; isso confirma o processo, não a saúde funcional completa.

| Migration | Frontend | Worker | Etapas depois das validações/confirmação |
|---|---|---|---|
| Não | Não | Não | Nenhuma ação de produção; baseline preservado |
| Sim | Não | Não | Migration confirmada → push → baseline |
| Não | Sim | Não | Push → Vercel READY/alias → baseline |
| Não | Não | Sim | Push → VPS/SHA/PM2 → baseline |
| Sim | Sim | Não | Migration confirmada → push → Vercel READY/alias → baseline |
| Sim | Não | Sim | Migration confirmada → push → VPS/SHA/PM2 → baseline |
| Não | Sim | Sim | Push → Vercel READY/alias → VPS/SHA/PM2 → baseline |
| Sim | Sim | Sim | Migration confirmada → push → Vercel READY/alias → VPS/SHA/PM2 → baseline |

O progresso fica em `.smart-deploy-progress.json`, separado do baseline e escrito
atomicamente. Ao retomar o mesmo SHA/baseline com `--execute`, as validações e
`DEPLOY` são repetidos, o histórico das migrations é consultado novamente, migrations
confirmadas não são reaplicadas e SHA já publicado não é reenviado. Vercel é sempre
reconfirmada; VPS pode repetir sua atualização/restart após falha parcial. Um SHA
com migration já publicado sem registro de confirmação controlada é bloqueado.
Progresso de outro SHA/baseline também bloqueia: reconcilie as etapas externas antes
de arquivar esse registro. Não há rollback ou repair automático.

Se a Vercel já terminou em erro/cancelamento, a retomada não cria um segundo deploy;
é necessário resolver a causa e autorizar uma recuperação específica fora deste
fluxo. Se a migration terminou parcialmente, reconcilie o histórico antes de retomar.
Se push terminou remotamente mas retornou erro local, o baseline permanece antigo;
a retomada verifica o remoto e reutiliza o mesmo SHA.

`.smart-deploy-state.json` só é substituído por rename atômico após todas as etapas
necessárias, usando o SHA congelado. `.smart-deploy.lock` impede dois processos locais;
após encerramento abrupto, confira que o PID não está ativo antes de remover o lock.
Os arquivos de estado/progresso/lock não são versionados.

A garantia entre migration e push depende de todos publicarem por este fluxo.
Proteja `main` contra pushes paralelos/externos. Migrations precisam ser compatíveis
com frontend e worker antigos durante a janela anterior à publicação. O projeto
Supabase vinculado e as credenciais Vercel precisam ser verificados pelo operador.
Esta regra passa a valer quando a configuração deste commit chegar à integração;
deployments já disparados anteriormente não podem ser ordenados retroativamente.

Testes offline: `npm run test:smart-change-classifier` executa toda a suíte smart,
com comandos simulados e repositórios Git temporários locais, sem produção.
