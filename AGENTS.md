# Regras permanentes do projeto

## Entrega e deploy

- Toda alteração solicitada neste repositório deve ser aplicada no ambiente de produção, incluindo o deploy na Vercel.
- Quando houver migrations ou mudanças de banco, elas devem ser aplicadas no Supabase antes do deploy da aplicação.
- Uma tarefa de alteração só pode ser considerada concluída depois de validar a compilação, aplicar as mudanças de banco necessárias e confirmar que o deploy de produção terminou com sucesso.
- Se o deploy ou a migration não puderem ser executados, informar claramente que a entrega está incompleta e explicar o bloqueio. Nunca apresentar uma mudança apenas local como concluída.
