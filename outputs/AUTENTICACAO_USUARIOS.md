# Autenticacao e controle de usuarios

## Configuracao

Configure na Vercel (e na VPS somente se ela executar esta aplicacao web):

- `MASTER_INITIAL_PASSWORD`: senha inicial do Master, com no minimo 8 caracteres. E usada apenas se `edifarra@gmail.com` ainda nao existir.
- `AUTH_SESSION_SECRET`: segredo longo e aleatorio usado para assinar cookies de sessao.
- `SESSION_MAX_AGE_MINUTES`: tempo de inatividade; padrao `60`.
- As variaveis existentes do Supabase, inclusive `SUPABASE_SERVICE_ROLE_KEY`.

Depois da primeira entrada, `MASTER_INITIAL_PASSWORD` pode ser removida do ambiente. A inicializacao nunca recria o Master nem sobrescreve sua senha.

## Banco de dados

Execute `supabase/migrations/015_app_users.sql` pelo fluxo de migrations usado no ambiente ou no SQL Editor do Supabase. A tabela `app_users` guarda nome, e-mail unico, hash da senha, indicador Master, status, versao de sessao, datas de criacao/atualizacao e ultimo login.

## Teste rapido

1. Aplique a migration e configure as tres variaveis.
2. Acesse `/login` com `edifarra@gmail.com` e a senha inicial.
3. Abra `Configuracoes > Usuarios`, crie um usuario comum e teste a entrada em uma janela anonima.
4. Confirme que o usuario comum nao ve o submenu e recebe HTTP 403 em `/api/users`.
5. Desative-o e confirme que a sessao existente deixa de funcionar.

## Fronteira de protecao

Paginas internas e APIs acionadas pela interface exigem sessao. Permanecem explicitamente fora da sessao humana:

- `/api/webhooks/*`
- `/api/mercado-livre/oauth/callback`
- `/api/shopee/oauth/callback`
- `/api/google/oauth/callback`
- `/api/pipeline/run` (cron/execucao tecnica; mantem a verificacao de `CRON_SECRET` da propria rota)

Os demais processos de Google Drive executados no servidor nao passam pelo middleware HTTP. Rotas de diagnostico, testes e inicio de OAuth sao humanas e continuam protegidas.
