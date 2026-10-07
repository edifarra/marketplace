# Regras permanentes do projeto

## Commits e Smart Deploy

- O Codex deve criar todos os novos commits com `npm run commit:smart -- -m "mensagem"`, após adicionar explicitamente ao index os arquivos da tarefa. Não usar `git commit` diretamente ou copiar trailers de outro commit.
- Esse comando regenera o plano cumulativo e inclui automaticamente `Smart-Deploy-Base` e `Smart-Deploy-Plan`. Usa exclusivamente o SHA do estado local de deploy confirmado. Nunca fabricar ou editar `.smart-deploy-state.json` para liberar um commit/deploy; se ausente, recuperar evidência do último deploy confirmado antes de continuar.
- Executar `npm run check:smart` e `npm run deploy:smart -- --dry-run` após o commit. A validação com arquivos pendentes valida apenas o código, não certifica o commit futuro.
- Commit publicado sem trailer: criar um novo commit pelo comando acima, mantendo o baseline confirmado e o diff cumulativo. Nunca amend, rebase, push forçado, baseline escolhido para esconder mudanças ou bypass da integridade.
- Restrições explícitas da tarefa (por exemplo, não executar deploy/migrations/VPS) prevalecem sobre a regra geral de entrega. Nesses casos, registrar o commit e informar que a publicação em produção permanece pendente; nunca declarar READY sem confirmação.

## Entrega e deploy

- Toda alteração solicitada neste repositório deve ser aplicada no ambiente de produção, incluindo o deploy na Vercel.
- Quando houver migrations ou mudanças de banco, elas devem ser aplicadas no Supabase antes do deploy da aplicação.
- Uma tarefa de alteração só pode ser considerada concluída depois de validar a compilação, aplicar as mudanças de banco necessárias e confirmar que o deploy de produção terminou com sucesso.
- Se o deploy ou a migration não puderem ser executados, informar claramente que a entrega está incompleta e explicar o bloqueio. Nunca apresentar uma mudança apenas local como concluída.

## Relatório obrigatório ao final de correções

- Toda correção deve ser registrada em commit antes da entrega final.
- Ao final de cada correção, informar exatamente:
  - Impacta Vercel? Sim/Não.
  - Impacta o worker da VPS? Sim/Não.
  - Precisa `git pull` na VPS? Sim/Não.
  - Precisa `npm ci`? Sim/Não.
  - Precisa `pm2 restart marketplace-worker --update-env`? Sim/Não.
  - Arquivos alterados.
  - Hash do commit.
- Se o resultado for "Vercel sim / VPS não", informar que o deploy foi concluído como `READY`.
- Se o resultado for "VPS sim" e o `package.json` ou o `package-lock.json` não tiver mudado, informar a necessidade de executar na VPS:

```bash
cd /opt/gestao-marketplace
git pull origin main
pm2 restart marketplace-worker --update-env
pm2 status marketplace-worker
```

- Se o resultado for "VPS sim" e o `package.json` ou o `package-lock.json` tiver mudado, informar a necessidade de executar na VPS:

```bash
cd /opt/gestao-marketplace
git pull origin main
npm ci
pm2 restart marketplace-worker --update-env
pm2 status marketplace-worker
```
