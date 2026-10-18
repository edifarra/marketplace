# Reconciliação local sem deploy

Estado desta implementação: BLOQUEADO para confirmação operacional. O leitor do
worker falha fechado porque o runtime atual não tem protocolo de prova do código
carregado. Não há bootstrap, migração automática, publicação ou reinício neste comando.

## Identidades e baseline

`--target` é o SHA completo implantado a reconciliar, não o HEAD da ferramenta.
O HEAD local e o main remoto podem ser descendentes do alvo apenas com alterações
em `scripts/smart-*.mjs`, testes Smart, este documento, plano Smart e `.gitignore`.
Ancestralidade é verificada com Git; commits ausentes localmente, divergência ou
mudanças de aplicação posteriores bloqueiam. Nenhum fetch é feito pela auditoria.
A permissão para descendentes identifica alterações operacionais, não prova que
outro deployment de aplicação foi implantado.

Confirmação exige baseline autêntico válido, `--expected-base=FULL_SHA`, data e
identidade de deployment. Não aceita baseline ausente. Recuperação do último
estado confirmado é um procedimento separado, com evidência e aprovação própria.
O alvo precisa descender do baseline; uma repetição não gera outro UUID/data.

## Coordenação e persistência

Definir `SMART_DEPLOY_CONTROL_ROOT` como o único checkout operacional canônico,
com baseline e progresso autênticos. Deploy execute e confirmação exigem esse
checkout; planejamento, dry-run e commit local podem usar uma cópia isolada.
Commit, deploy e confirmação usam o mesmo lock exclusivo por usuário/host em
`AppData/Local/Temp/edifarra-marketplace-HASH_DO_USUARIO.lock` no Windows
e `/tmp/edifarra-marketplace-HASH_DO_USUARIO.lock` em POSIX, independente do cwd
e de overrides TEMP/TMP. O hash identifica o diretório de usuário. A raiz legada
`.smart-deploy.lock` também impede operação até inspeção manual.

O lock contém UUID, PID, hostname, raiz, operação e instante. Não há expiração ou
remoção automática por idade/PID. Após interrupção: manter todas as operações
paradas; inspecionar dono, host, identidade e atividade do processo; verificar
baseline, progresso e histórico; somente então, com autorização operacional,
renomear o lock órfão para investigação. Nunca apagar um lock ativo. A liberação
normal só remove o UUID que adquiriu. Todos os participantes devem usar a versão
nova e o mesmo checkout canônico. Hosts/usuários diferentes e ferramentas antigas
não participam deste lock: coordenar uma janela sem deploy concorrente.

Baseline e progresso são comparados byte a byte após a auditoria e antes da
substituição. Só um journal com alvo/base exatos pode ser reconciliado. Evidências
incluem o journal e seu digest, persistidos antes do estado. Depois da troca do
estado, o journal é removido para impedir retomada de etapas reconciliadas.
Uma queda nesse intervalo deixa recibo no estado: repetir a confirmação limpa
somente o journal cujo digest coincide, sem nova auditoria/UUID/deployedAt.
Estado já no alvo sem recibo verificável bloqueia a confirmação duplicada.
Histórico órfão sem referência no estado não significa sucesso.

Arquivos de evidência e temporários recebem fsync; diretórios também são
sincronizados na confirmação. Em plataformas que não suportam fsync de diretório
(como o Node/Windows usado aqui), a confirmação é bloqueada antes da escrita.
Os testes positivos no Windows injetam apenas a sincronização de diretório;
isso valida a lógica, não certifica resistência a queda de energia. Renomear
atomicamente não transforma leituras remotas em uma transação distribuída.

## Supabase

Definir `SMART_SUPABASE_BIN` como caminho absoluto de um executável existente.
Não usar instalação/download implícito por npx. A implementação consulta versão e
help antes da leitura. As versões locais verificadas são 2.118.0 e 2.121.0; somente
essas versões e help compatível são aceitos. A execução local do help foi
reproduzida nas duas versões. Outras versões exigem revisão e fixture própria.

Nessa versão, `--output-format` existe e é diferente de `--output`. O leitor usa
`migration list --linked --project-ref=REF --output-format text`, evitando supor
um envelope JSON. O parser também mantém suporte ao JSON legado dos testes;
rejeita conteúdo desconhecido, linhas malformadas, duplicadas, versões extras,
incompatíveis e histórico incompleto. Não há confirmação por contagem isolada.

O project-ref explícito precisa coincidir com o vínculo local antes e depois da
consulta. Overrides de URL/workdir/profile/host são rejeitados. A seleção remota
fica explícita na CLI; a prova é do histórico dessa conexão vinculada, não uma
atestação criptográfica do servidor. Arquivos locais de migrations precisam
coincidir com o alvo implantado mesmo que HEAD seja o commit novo da ferramenta.

O histórico comprova versões de migrations; não comprova SHA do Supabase, conteúdo
SQL aplicado nem ausência de alterações manuais de schema. Não executar db push
para resolver uma auditoria bloqueada de um SHA já publicado.

## Vercel

Exige vínculo local e resposta autenticada com projeto/time esperados. Domínios
esperados devem ser informados explicitamente em `--production-domains=a,b`;
não inferir um domínio de aliasAssigned. Consulta cada alias por domínio com escopo
de projeto/time, exige destino no deployment exato, sem redirect ou exclusão.
Exige SHA completo, produção, READY, promoção atual e aliasAssigned booleano true
ou timestamp numérico positivo finito. Strings/coerção numérica são rejeitadas.
O projeto é relido após os aliases e a prova é repetida perto da gravação.
Divergência ou resposta reduzida sem campos necessários bloqueia.

## Worker na arquitetura atual

`ecosystem.config.cjs`: PM2 inicia `npm run worker:marketplace`, com cwd
`/opt/gestao-marketplace`; esse script inicia tsx/Node. O PID PM2 pode ser o wrapper
npm, não o Node que carregou os módulos. Não há release imutável provisionada nem
SMART_WORKER_SHA confiável no ambiente inicial.

O probe lê checkout e /proc, procura o Node com a entrada do worker, registra PID,
PPID, cwd e startTicks e verifica estabilidade. Não lê ambientes nem executa pm2
jlist: esse comando pode iniciar daemon se ausente. A coleta é contextual e nunca
é aceita como prova do código carregado; todos os resultados atuais bloqueiam.

Evidência suficiente requer um protocolo futuro no Node efetivo: desafio novo,
boot_id/startTicks/PID e árvore de ancestrais vinculados à instância/configuração
PM2; manifesto de hashes capturado quando os módulos foram carregados, incluindo
entrada, módulos transitivos, runtime e dependências; resposta estável para todas
as instâncias esperadas. Um arquivo solto, hash do checkout atual, log antigo,
PM2 online ou marcador de SHA não substituem isso. Esse protocolo ainda NÃO está
implementado neste patch. Sua instrumentação e eventual reinício exigem tarefa e
aprovação de produção separadas. Não há opção para ignorar o bloqueio.

## Comandos futuros (não executados nesta tarefa)

Auditoria, após configurar ferramentas/vínculos autênticos:

```text
node scripts/smart-reconcile.mjs --mode=audit --target=f6414359a3d91327d36fa88c0a4296ff7cf5eb9f --deployment=dpl_gW9AJ43QcPkq2Zzm6mHWzGemeMvE --project-ref=REF --production-domains=DOMINIO_CONFIRMADO
```

Confirmação é uma ação diferente, somente após revisão de evidência nova e
aprovação humana específica. Enquanto o protocolo do worker faltar, ela falhará.
As opções adicionais são `--mode=confirm --expected-base=BASE_AUTENTICA`,
`--authorization="RECONCILE FULL_SHA"` e `--actor="operador"`. Esses argumentos são
declarações, não autenticação ou prova de aprovação independente. Não executar
esse modo por inferência a partir de autorização para corrigir o patch local.
