# Especificação — Chats e Perguntas dos Marketplaces

Status: especificação aprovada para implementação futura.

Esta etapa não autoriza implementação, migration ou deploy. Na próxima conversa, a solicitação esperada será a implantação completa desta funcionalidade.

## Objetivo

Criar uma tela unificada chamada **Chats e Perguntas** para concentrar:

- Perguntas públicas de pré-venda do Mercado Livre.
- Mensagens privadas de pós-venda do Mercado Livre.
- Conversas de chat da Shopee, com ou sem produto ou pedido vinculado.

O novo item deve ficar no **Menu principal**, imediatamente acima de **Estoque**.

## Menu e indicador de pendências

- Adicionar o item **Chats e Perguntas** acima de Estoque.
- Exibir uma bolinha vermelha no menu quando existir qualquer pergunta ou conversa pendente.
- Envios que terminaram com erro também mantêm a bolinha vermelha.
- Remover automaticamente o indicador quando não houver pendências.

## Tela e grade

A tela terá filtros superiores, grade, paginação e botão **Atualizar agora**.

- Paginação inicial: 25 atendimentos por página.
- Registros pendentes nascem abertos.
- Registros respondidos podem nascer recolhidos.
- Ordenação inicial: pendentes mais antigas primeiro.

### Filtros mantidos

- Marketplace.
- Loja.
- Situação: pendente, respondida, encerrada, em revisão, spam/bloqueada e erro.
- Dentro ou fora do SLA.
- SKU, título, comprador ou pedido.
- Período.
- Somente não lidas.

### Filtros descartados

- Pré-venda/Pós-venda.
- Com produto/Sem produto.

Essas características podem ser exibidas no atendimento, mas não serão filtros.

## Linha principal da grade

Exibir:

- Bolinha vermelha no começo quando houver resposta pendente ou envio com erro.
- Microícone do marketplace.
- Nome da loja configurada: ML-ED, ML-GI, SP-ED ou SP-GI.
- SKU, quando disponível.
- Título do produto, quando disponível.
- Valor, quando disponível.
- Estoque disponível atual.
- Tempo sem resposta, por exemplo: `Há 35 minutos` ou `Há 1h e 20 min`.
- Data e hora do envio da pergunta ou última mensagem recebida.
- Estado do SLA.
- Controle para abrir ou recolher.

Quando uma conversa Shopee não tiver produto associado, não forçar associação com SKU. Mostrar **Conversa geral da loja**.

## Conteúdo aberto do atendimento

- Nome, apelido ou identificador mascarado da pessoa, conforme os dados permitidos pela API.
- Histórico da conversa.
- Identificação visual entre mensagens do comprador e da loja.
- Data e hora de cada mensagem.
- Pergunta pública do Mercado Livre e sua resposta, quando aplicável.
- Caixa de resposta com contador de caracteres.
- Alertas ou bloqueios de conteúdo proibido.
- Estado de envio e erro.
- Ação manual **Tentar novamente** após esgotar as tentativas automáticas.

## Pré-venda e pós-venda

A separação será somente visual dentro do histórico, sem filtro:

1. Linha divisória com o texto **Pré-venda**.
2. Perguntas e mensagens anteriores à compra.
3. Marco da compra, quando houver vínculo seguro, por exemplo: `Compra realizada — Pedido 123456 — 24/08/2026 às 14:32`.
4. Linha divisória com o texto **Pós-venda**.
5. Mensagens posteriores à compra.

Não presumir que a pessoa que fez uma pergunta foi quem comprou. O marco só deve ser exibido quando comprador, anúncio e pedido puderem ser relacionados com segurança.

## SLA configurável

Adicionar em **Configurações Gerais**:

- **SLA de Chats com Produtos Vinculados**: inicialmente 1 hora.
- **SLA de Chats sem Produtos Vinculados**: inicialmente 6 horas.

Regras:

- Mercado Livre com produto vinculado: 1 hora.
- Shopee com produto vinculado: 1 hora.
- Conversas sem produto vinculado: usar a configuração inicialmente definida em 6 horas.
- Dentro do SLA: tempo em verde.
- Fora do SLA: tempo em vermelho.
- Respondida, encerrada, em revisão ou impossibilitada de responder: estado neutro/cinza.

## Indicador de pendência

- Pergunta pública não respondida do Mercado Livre: bolinha vermelha.
- Pergunta respondida: sem bolinha.
- Nova mensagem pós-venda do comprador: bolinha vermelha.
- Na Shopee, a conversa volta a ficar pendente quando a última mensagem efetiva for do comprador.
- Saudação ou resposta automática não deve marcar o atendimento como resolvido.
- Falha de envio mantém a pendência e a bolinha vermelha.

Não será implementado, nesta primeira versão, bloqueio contra dois operadores respondendo simultaneamente.

## Respostas e limites

- Usar limite de até 2.000 caracteres, que corresponde ao limite oficial do Mercado Livre.
- Mostrar alerta visual a partir de 1.800 caracteres.
- Antes de responder uma pergunta pública do Mercado Livre, exigir confirmação explícita.
- Informar nessa confirmação que a resposta pública só pode ser enviada uma vez e não pode ser corrigida posteriormente.
- Manter rascunho se o envio falhar.

## Validação de conteúdo

Bloquear ou alertar para:

- Telefones e padrões de WhatsApp.
- E-mails.
- CPF, CNPJ e documentos pessoais.
- Endereços.
- Links externos e encurtadores.
- Redes sociais e identificadores externos.
- Chaves Pix, contas bancárias e meios de pagamento externos.
- Solicitação de senha, PIN ou código de segurança.
- Linguagem ofensiva ou conteúdo inapropriado.
- Incentivo à negociação ou pagamento fora do marketplace.
- Incentivo indevido para abrir ou deixar de abrir reclamação.

Aplicar bloqueio rígido para telefone, e-mail, WhatsApp, Pix e links externos. Para termos ambíguos, usar aviso confirmável. Links internos não devem ser liberados apenas pelo domínio; usar uma lista controlada de destinos permitidos.

## Fila, tentativas e idempotência

Reutilizar a fila de atividades já existente.

- Após falha no envio, tentar novamente em 1 minuto.
- Fazer no máximo 5 tentativas automáticas.
- Manter pergunta/conversa com erro visível e bolinha vermelha durante as tentativas.
- Depois da quinta falha, manter o erro e oferecer **Tentar novamente** manualmente.
- Preservar o texto digitado como rascunho.
- Implementar idempotência para evitar resposta duplicada mesmo com repetição de webhook, fila ou ação manual.
- Uma falha de API nunca deve remover a pendência.
- Registrar operador, horário, conteúdo enviado, número da tentativa e retorno do marketplace.

## Atividades Recebidas

Identificações aprovadas:

- Nova pergunta.
- Nova mensagem.
- Conversa atualizada.
- Pergunta encerrada.

## Atividades Enviadas

Identificações aprovadas:

- Resposta enviada — sucesso ou erro.
- Pergunta respondida — sucesso ou erro.

Cada tentativa pode ser registrada no histórico técnico, preservando uma apresentação clara do estado final para o usuário.

## Regras específicas do Mercado Livre

- Perguntas públicas são vinculadas ao anúncio.
- Tratar os estados oficiais `UNANSWERED`, `ANSWERED`, `CLOSED_UNANSWERED` e `UNDER_REVIEW`, além de conteúdo banido, removido, em espera ou suspeito de spam.
- Quando o anúncio for encerrado, respeitar `CLOSED_UNANSWERED` retornado pela plataforma.
- Anúncio pausado ou encerrado pode impedir resposta.
- A resposta pública só pode ser enviada uma vez.
- Perguntas antigas podem ser removidas pela plataforma.
- Consumir o tópico de notificação `questions`.
- Incluir mensagens privadas pós-venda do Mercado Livre no escopo, não apenas perguntas públicas.

## Regras específicas da Shopee

- A Shopee trabalha com conversas de chat, não com o mesmo modelo de pergunta pública do Mercado Livre.
- Uma conversa pode tratar de produto, loja, pedido, oferta ou pós-venda.
- Consultar lista de conversas, histórico de mensagens e detalhes da conversa, e enviar respostas pelos recursos oficiais disponíveis para a conta.
- Quando produto for finalizado ou ficar sem estoque, não fechar automaticamente o chat.
- Mostrar **Produto sem estoque** ou **Anúncio finalizado**, mantendo a conversa disponível para suporte e pós-venda.
- Conversas gerais podem não possuir SKU, título, valor ou estoque.

## Produto encerrado ou sem estoque

- Mercado Livre: respeitar o estado retornado pela plataforma e bloquear resposta quando ela não for permitida.
- Shopee e mensagens pós-venda: manter a conversa aberta e sinalizar a indisponibilidade do produto.

## Atualização e sincronização

- Atualização primária pelos webhooks e pela fila já existente.
- Botão **Atualizar agora**.
- Sincronização periódica de segurança para recuperar eventos perdidos.
- Tratar notificações duplicadas e fora de ordem.
- Não assumir que o estoque recebido junto à mensagem é atual; exibir o estoque atual do sistema.

## Recursos visuais

Usar os microícones fornecidos para Mercado Livre e Shopee. O projeto já contém versões mini em `public/marketplaces`, que podem ser comparadas aos anexos e reutilizadas se estiverem adequadas.

## Entrega futura obrigatória

Quando a implementação for solicitada:

1. Criar e validar as migrations necessárias.
2. Aplicar as migrations no Supabase antes do deploy.
3. Implementar integrações, fila, tela, filtros, menu, indicadores e configurações.
4. Validar compilação e testes proporcionais ao risco.
5. Fazer deploy de produção na Vercel.
6. Confirmar que o deploy terminou com sucesso.

A tarefa não poderá ser apresentada como concluída se banco ou deploy de produção não forem aplicados com sucesso.
