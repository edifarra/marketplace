# Commits com integridade e recuperação dos chats pendentes

O commit f15883068ac1c57e201af4016ecfe4f5d860ec50 foi publicado sem trailers e manteve um plano antigo, cujo baseline era bffd8d739e2aa51363f05e212e4d2eb658085733. O último deploy confirmado no estado local é 575b46c562cd2d7cbb0c50cdf64d1f34bd0620fb. Classificação correta de arquivos não certifica metadados: antes desta correção check:smart apenas validava código e dry-run não chamava a validação exclusiva do preflight de execução.

## Fluxo obrigatório para o Codex

1. Adicionar explicitamente os arquivos da tarefa ao index.
2. Executar `npm run commit:smart -- -m "mensagem"`.
3. Executar `npm run check:smart` e `npm run deploy:smart -- --dry-run` com a árvore limpa.

O comando gera e adiciona o plano cumulativo desde o estado confirmado, inclui ambos os trailers e verifica o commit criado. Não aceita baseline informado pelo chamador, trailer manual, amend ou push. O estado local continua sendo evidência operacional: não é assinatura criptográfica e não deve ser fabricado. deploy:prepare permanece uma ferramenta manual; isoladamente não cria um commit nem garante seus trailers.

O dry-run agora exige baseline explícito ou estado confirmado (sem fallback para HEAD^), verifica os trailers, digest e diff real. Não consulta rede nem certifica que origin/main esteja atualizado. check:smart com alterações pendentes informa explicitamente que valida somente código; com árvore limpa valida também os metadados do commit.

## Publicação segura quando autorizada

Não alterar f158830 nem o baseline para escondê-lo. Um novo commit de recuperação, criado pelo fluxo acima, inclui no plano todas as mudanças dos chats e desta correção desde 575b46c562cd2d7cbb0c50cdf64d1f34bd0620fb. O hash novo é o alvo de publicação e deploy; o commit antigo continua intacto.

Após revisar o commit novo e autorizar produção:

```powershell
npm run check:smart
npm run deploy:smart -- --dry-run
npm run deploy:smart -- --execute
```

Na execução, revisar o plano e confirmar DEPLOY. Deixar o Smart Deploy fazer o push normal após suas validações. Não publicar antecipadamente por comando paralelo. Ele mantém árvore limpa/main, HEAD fixo, origem estável, fetch e ancestralidade de origin/main, publicação do SHA exato, lock, journal de retomada, verificação READY na Vercel e atualização do baseline somente no fim. Uma execução interrompida deve ser retomada segundo o journal, nunca removendo-o para contornar proteções. Se origin/main avançou ou divergiu, interromper e revisar antes de continuar; nenhum push forçado é permitido.

Esta tarefa não autoriza executar o último comando, migrations ou ações na VPS. A publicação dos chats permanece pendente até confirmação de produção.
