# Aposentadoria dos vínculos residuais Tiny

## Escopo e invariantes

O único vínculo operacional Tiny é `products.tiny_product_id` preenchido. `sent_target = TINY`, `TINY_LAST_PRODUCT_*` e `TINY_LEGACY_LINK_*` são históricos. O envio explícito ao Tiny continua disponível e pode criar um vínculo novo. A sincronização pontual não procura no Tiny um produto sem ID atual. Atividades antigas de atualização, estoque e exclusão são ignoradas se o ID atual estiver ausente ou diferente; novas criações explícitas continuam permitidas.

As telas separam integrações operacionais do histórico. Nenhum registro anterior de envio é apagado. A limpeza altera exclusivamente `products.sent_target`; não altera status, timestamps, SKUs, estoques, anúncios, imagens ou histórico comercial.

## Limpeza preparada (não executada)

Migration: `supabase/migrations/20261025185303_retire_legacy_tiny_markers.sql`.

1. Bloqueia escritas em products durante a operação atômica.
2. Seleciona somente `sent_target = 'TINY'` sem ID Tiny atual.
3. Aborta se exceder 3.235 produtos, exigindo revisão do limite auditado.
4. Salva por produto em `settings.TINY_LEGACY_LINK_<id>`: ID, SKU, sent_target, sent_at, tiny_product_id, updated_at e data do backup. Não substitui backups existentes.
5. Aborta integralmente se algum backup existente divergir dos valores atuais.
6. Limpa somente sent_target e informa o total. Se reaplicada após sucesso, não altera produtos já limpos.

Recuperação: `docs/tiny-legacy-links-rollback.sql`, manual, após revisão. Restaura somente o marcador de produtos que continuam sem vínculo e cujos campos protegidos não mudaram. Mantém o backup. Isso não reativa o Tiny: um ID atual continua obrigatório. Produtos que mudaram após a limpeza precisam de recuperação individual revisada.

## Plano de publicação Smart Deploy (etapa futura)

Baseline confirmado: `2fa1901367955d89a5a753d43ac723b1d9b34dbb`. O alvo é o commit que contém este documento e seu `.smart-deploy-plan.json`, com trailers gerados por `commit:smart`. Nunca alterar o estado local de deploy para liberar a publicação.

Preparação já autorizada nesta etapa: testes de regressão, compilação local, commit Smart, `npm run check:smart` e `npm run deploy:smart -- --dry-run`. O dry-run não verifica o estado remoto.

Quando a publicação for autorizada, em checkout limpo no commit alvo, definir a CLI existente e executar:

```powershell
$env:DO_NOT_TRACK = '1'
$env:SMART_SUPABASE_BIN = (Resolve-Path '.npm-cache/_npx/b96a6bd565c470ce/node_modules/@supabase/cli-windows-x64/bin/supabase.exe').Path
npm run check:smart
npm run deploy:smart -- --dry-run
npm run deploy:smart -- --execute
```

O caminho acima corresponde à CLI local 2.118.0 já instalada; em outra máquina, usar caminho absoluto de CLI validada, sem download implícito. Manter as credenciais e os vínculos existentes de Supabase/Vercel. O executor pede `DEPLOY` antes de qualquer publicação.

Ordem exata do executor: conferir baseline/metadados/checkout/origin e projetos vinculados; executar testes relacionados, typecheck e build; solicitar confirmação; conferir migrations; aplicar migrations pendentes no Supabase e confirmar o histórico; publicar o SHA exato em origin/main; confirmar Vercel de produção READY e alias desse SHA; atualizar a VPS para esse SHA, reiniciar o worker e confirmar PM2 online; somente então atualizar o baseline confirmado. Se houver migrations pendentes anteriores, revisar a lista antes da confirmação.

Impactos previstos: Vercel SIM; VPS/worker SIM (proteção na fila compartilhada); Supabase SIM (limpeza recuperável, sem mudanças de schema); dependências NÃO. Não é necessário npm ci. O Smart Deploy atualiza a VPS e reinicia o worker automaticamente. Equivalente operacional exigido pelo projeto, apenas para execução futura e sem duplicar se o Smart Deploy já confirmou:

```bash
cd /opt/gestao-marketplace
git pull origin main
pm2 restart marketplace-worker --update-env
pm2 status marketplace-worker
```

## Verificação após publicação

- Confirmar o SHA em produção e no worker, Vercel READY com alias e PM2 online.
- Confirmar zero marcadores legados sem ID Tiny e o total de backups; comparar com a contagem imediatamente anterior (esperados 3.235 conforme auditoria).
- Abrir 1130AU: Tiny ausente das integrações operacionais e presente somente no histórico; ML/Shopee preservados.
- Verificar ausência de novas operações Tiny de vínculos aposentados. Não excluir um produto comercial real para validar a entrega.
- Comparar os dados protegidos com o snapshot pré-publicação. A migration não toca essas colunas/tabelas.

Nenhum push, deploy, migration ou comando na VPS está autorizado nesta etapa. A publicação permanece pendente; não declarar READY.
