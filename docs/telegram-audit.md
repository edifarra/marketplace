# Auditoria Telegram — 16/10/2026

## Evidências somente de leitura em produção

Projeto vinculado: ukfefrdaivqzxeeknmqr. Configuração: enabled=false,
new_sale_enabled=false, dispatch_enabled=false; America/Sao_Paulo, novas vendas
11:00–13:00, despacho 16:30. Cron jobid=4 ativo, */5 * * * *, chamando
/api/telegram/dispatch-check. Foram 288 execuções SQL succeeded nas últimas 24h.
Esse status comprova a execução do SQL do cron, não o sucesso HTTP do endpoint.
telegram_notification_jobs estava vazio; histórico tinha um registro sent anterior
à auditoria. Nenhum token, Chat ID ou conteúdo de mensagem foi consultado.

## Causa e fluxo existente

A migration 036 cria um cron incondicional. Não havia trigger nem chamada ao cron
no salvamento. A tela envia checkboxes como booleanos, horários e fuso; a tabela
singleton guarda as opções e o token cifrado AES-256-GCM. Token vazio preserva o
token anterior. A página exige usuário master e mostra os últimos 100 históricos.

O GET do endpoint exige x-supabase-cron-secret igual a SUPABASE_CRON_SECRET.
O cron obtém o segredo do Vault. O job lê configuração e retorna disabled antes
de consultar pedidos se o módulo ou despacho estiver desligado. Portanto o gasto
desnecessário atual é cron + HTTP + invocação + consulta de configuração, não
consulta de pedidos. Sem despacho devido, retorna not_due. Quando devido, reserva
uma execução diária única antes de buscar vendas do dia com etiqueta impressa.
Ignora status final e pedidos já postados e envia um resumo se houver pendentes.

Novas vendas são acionadas por notifyNewSale no processamento de vendas, sem cron
próprio. Respeitam as duas flags e a janela, consultam venda/itens e descartam
cancelados/reembolsados/não pagos. Atualizações posteriores também tentam avisar;
não existe fila de mensagens para vendas que ficaram fora da janela. A chave
new_sale:marketplace:order_id impede repetição. Despacho usa pending_dispatch:data.
Histórico e jobs têm unicidade persistente; falhas também retêm as reservas e
não são reenviadas automaticamente. Essa política foi preservada.

O despacho já existente pode consultar Mercado Livre e reconciliar pedidos Shopee
para atualizar a identificação de postagem. Esse fluxo não foi executado na
auditoria nem alterado; nenhuma regra de vendas, estoque ou marketplace mudou.

## Correção preparada

A nova migration instala um trigger privado, SECURITY DEFINER com search_path
vazio e EXECUTE revogado dos papéis de API. Ele precisa de privilégios do dono do
cron para chamar cron.alter_job; não é RPC pública. Salvar enabled/dispatch_enabled
altera active do job existente na mesma transação. Se faltar o cron, o salvamento
falha explicitamente e reverte, evitando confirmação falsa. A migration também
reconcilia o estado inicial, preservando job, URL, frequência, Vault e histórico.

- Desativado: cron inativo; chamadas residuais param na configuração.
- Ativado só para novas vendas: cron inativo; processamento por eventos continua.
- Ativado com despacho: mesmo cron reativado; primeira passagem após o horário
  configurado, com granularidade de cinco minutos e no máximo uma execução diária.
- Desligar despacho ou Telegram volta a pausar o cron.

O teste manual agora exige Telegram ativo, inclusive no backend. Antes do envio,
o backend relê flags e horário, reduzindo envios de trabalho em andamento após
desativação. Uma requisição já enviada ao Telegram não pode ser cancelada.
Chat ID vazio preserva o salvo; token permanece preservado. Fuso inválido é
rejeitado antes de salvar. O intervalo diário usa o fuso configurado, inclusive
mudanças de horário de verão; janela de novas vendas aceita atravessar meia-noite.

## Verificação e publicação

Testes sem rede cobrem flags desligadas, teste manual bloqueado, despacho ainda
não devido, bloqueio pela reserva diária, janelas e fuso com horário de verão.
Teste PostgreSQL isolado usa substituto de cron.alter_job para verificar a migration,
pausa inicial, combinações de flags, reativação, credenciais preservadas, restrição
de EXECUTE e rollback quando falta o job. Não testa o daemon pg_cron real.
Build de produção passou. check:smart e deploy:smart -- --dry-run são executados
após o commit; consultar o relatório da entrega para os resultados finais.

Publicação depende de autorização explícita: aplicar a migration antes do deploy
Vercel e atualizar o worker VPS, que importa lib/telegram-notifications.ts via
inventory. Não há dependências novas no projeto, portanto npm ci não é necessário.
Não foram enviados testes Telegram nem executados deploy, migrations remotas ou
alterações de cron/configuração/histórico em produção.
