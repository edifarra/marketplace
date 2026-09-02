# Regras permanentes do projeto

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
