# Validação da revisão local

Compilação de produção local: `npm run build` concluído com sucesso, incluindo TypeScript, geração de páginas e finalização. Existe aviso preexistente de depreciação do suporte React 18 pelo Next.js; não impede a compilação.

Suíte explícita de regressão: **81 testes passaram, zero falhas**. Executada com o registro `server-only` já existente no projeto:

```bash
npx --no-install tsx --require ./scripts/register-server-only.cjs --test tests/product-vps-images.test.ts tests/cloudinary-upload-policy.test.ts tests/marketplace-image-recovery.test.ts tests/product-image-replacement.test.ts tests/marketplace-stock-reactivation.test.ts tests/mercado-livre-picture-confirmation.test.ts tests/outgoing-activities-post-processing.test.ts tests/marketplace-case-list.test.ts tests/marketplace-case-detail.test.ts tests/marketplace-case-layout.test.ts
```

Uma primeira execução direta das regressões adicionais falhou ao importar `server-only`; a suíte passou com o carregador oficial do projeto. O teste antigo que esperava recuperação baseada exclusivamente em Cloudinary foi atualizado para verificar disponibilidade da original selecionada. Erros de TypeScript no teste novo e na tipagem da mescla foram corrigidos; a compilação final passou.

Validação real somente de leitura: SELECT do SKU **1096AU**, três referências `local_url` nas posições **1, 2 e 3**, três respostas **HTTP 200 / image/jpeg**. Snapshot e resultados preservados em `1096AU-before.json`. A tentativa dentro do sandbox não alcançou a rede; a execução liberada foi limitada ao mesmo script somente de leitura e passou. Não houve escrita em produção.

Os resultados de `npm run check:smart` e `npm run deploy:smart -- --dry-run`, obrigatoriamente posteriores ao commit, são informados na mensagem final. O dry-run não confirma status remoto, não publica e não certifica READY.

A validação Smart também foi executada com o baseline confirmado explícito para cobrir todo o commit. Ela encontrou duas falhas de fixtures em testes de parâmetros de páginas: o mock não reconhecia o novo seletor. O fixture foi atualizado para usar a função real. As falhas iniciais de testes Git temporários no sandbox foram resolvidas executando a mesma validação com permissão para criar esses repositórios de teste.

## Arquivos da tarefa

```text
.smart-deploy-plan.json (regenerado exclusivamente por commit:smart)
app/api/vendas/[id]/imagem/route.ts
app/central-reclamacoes/case-display.ts
app/central-reclamacoes/case-grid.tsx
app/components/product-thumbnail.tsx
app/produtos/[id]/page.tsx
app/produtos/[id]/product-editor.tsx
app/produtos/actions.ts
app/produtos/page.tsx
app/vendas/page.tsx
lib/cloudinary.ts
lib/direct-marketplace-publisher.ts
lib/marketplace-case-detail.ts
lib/marketplace-case-list.ts
lib/marketplace-temporary-images.ts
lib/outgoing-activities.ts
lib/prepare-marketplace-images.ts
lib/product-cloner.ts
lib/product-image-source.ts
lib/product-marketplace-images.ts
lib/tiny.ts
scripts/prepare-vps-image-review.mjs
tests/cloudinary-upload-policy.test.ts
tests/marketplace-image-recovery.test.ts
tests/product-vps-images.test.ts
tests/search-params-pages.test.ts
docs/image-vps-review/README.md
docs/image-vps-review/validation.md
docs/image-vps-review/1096AU-before.json
docs/image-vps-review/1096AU-forward.sql
docs/image-vps-review/1096AU-rollback.sql
```

`package.json`, `package-lock.json`, `.smart-deploy-state.json` e migrations não foram alterados. Não houve push, deploy, SQL de escrita, restart, limpeza de fotos ou envio externo.

A regra `overwrite=false` retorna o asset existente quando o ID já existe, conforme a [referência oficial da API Cloudinary](https://cloudinary.com/documentation/image_upload_api_reference). O ID inclui a origem, seu conteúdo e a política de tratamento; essa regra evita refazer a transformação numa repetição após falha de persistência.
