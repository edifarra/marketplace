# Edição de fotos — auditoria local de 03/11/2026

Baseline confirmado: `daf83dab08fab5cec7f5ed8ff0ce5a7193e25e60`.
Esta entrega é parcial. Não houve push, deploy, migrations, acesso ao banco de produção nem exclusão real. O relatório anterior descreve o baseline; este documento registra o complemento.

## Implementado

- `signRecoverySequence` assina a sequência realmente apresentada pelo servidor após `mergeRecoveredImages`. O comprovante contém produto, IDs/posições anteriores, origem do anúncio e validade de 24 horas. Não aceita uma declaração de “não editei” enviada pelo cliente.
- `ProductDetailPage` emite o comprovante; `ProductEditor` o devolve ao salvar.
- `recoverySequenceChanged` compara a sequência final com a inicial assinada. Inclusão, exclusão e reordenação efetivas continuam exigindo sincronização. Uma alteração desfeita, com sequência final idêntica, não exige envio de fotos.
- `updateProductDetailsAction` separa `imagesPersistChanged` de `imagesMarketplaceChanged`. Recuperação pura continua sendo processada na VPS e persistida pela RPC existente. Com saldo positivo, `enqueueDirectListingUpdates` recebe `images: false`; preço, atributos, título e estoque mantêm os argumentos anteriores. Tiny mantém sua sinalização anterior de persistência, pois não faz parte desta mudança de decisão dos marketplaces.
- IDs/posições diferentes do snapshot, origem diferente, assinatura inválida ou comprovante expirado impedem salvar com aquele comprovante. Editores antigos sem comprovante mantêm a decisão conservadora anterior (sincronizam imagens); precisam ser reabertos após a publicação.
- Não foram alterados preparação de capa, download limitado, autenticação, filas, reconciliação, armazenamento ou RPC de substituição.

## Impedimento 1: fotos futuras com estoque zerado

`updateProductDetailsAction` sempre grava `marketplace_update_pending: true` quando o estoque fica zerado, inclusive sem nenhuma edição de fotos. `syncListingsStock` em `lib/inventory.ts` consome essa pendência com `images: true`. Portanto separar a decisão no salvamento elimina o envio imediato, mas **não resolve a exigência de não reenviar fotos na futura reposição de estoque**.

Não basta deixar de gravar a pendência na recuperação: isso perderia alterações simultâneas de preço/título/atributos e poderia apagar intenção anterior legítima. A pendência também pode ter sido criada por outros fluxos. Não foi alterada a reconciliação nem introduzida coluna implicitamente, conforme a restrição de escopo do pedido.

Alternativa recomendada para decisão: intenção durável de imagens separada da pendência geral (coluna ou registro de intenções). Novas edições manuais acumulam essa intenção; recuperação pura não a cria nem limpa uma intenção anterior. A reposição usa essa intenção para `images`, com tratamento conservador de pendências legadas. A criação, leitura e consumo devem ser versionados/atômicos para que um salvamento concorrente não perca intenção. Exige migration, atualização da reconciliação e testes locais de SQL/worker antes de publicação. Alternativa: substituir a pendência geral por intenções versionadas por campo; é mais ampla e não foi implementada.

## Impedimento 2: exclusão física e uploads abandonados

O fluxo atual usa nomes imutáveis determinísticos por produto/posição/conteúdo. Uma nova preparação pode reutilizar exatamente o mesmo caminho. A RPC 091 retorna `void`, não retorna um manifesto durável de arquivos removidos e não coordena vinculações com o SFTP. A preparação manual grava arquivos definitivos antes do Salvar; expirar o HMAC não apaga nem invalida o arquivo para outros fluxos.

Consultar `product_images` e depois executar `unlink` é inseguro: outra transação pode vincular o arquivo entre essas operações. Esperar alguns minutos ou verificar duas vezes não elimina essa janela. Timeout da RPC pode significar commit realizado com resposta perdida. Nem padrão de URL nem nome por hash, isoladamente, provam propriedade para exclusão de arquivos históricos.

Por essas razões, **exclusão física e coleta de preparados não foram ativadas**. Remoção visual, cancelamento, reordenação, erros e abandono continuam preservando arquivos. Arquivos órfãos continuam possíveis. Não há promessa de limpeza que o código não cumpra. Os testes de exclusão bem-sucedida, referências compartilhadas e falhas de limpeza ainda dependem da arquitetura abaixo; não foram substituídos por testes de funções desconectadas do fluxo real.

### Proposta de ciclo de vida (não implementada)

1. Registrar apenas novos ativos gerenciados, com ID/caminho exclusivo não reutilizável, origem comprovada, sessão de preparação, prazo de lease e estados `prepared`, `linked`, `deleting`, `deleted`. Não cadastrar nem coletar retroativamente órfãos antigos.
2. Fazer **todos** os escritores de vínculos participantes respeitarem o registro: RPC do editor, importação do Drive e demais inserções/atualizações. Serializar por ativo. Não basta proteger apenas o editor.
3. Na mesma transação que confirma o conjunto final, validar versão do conjunto, reivindicar preparados, criar vínculos e registrar candidatos à limpeza removidos. Reordenação não gera candidato; referências de outros produtos impedem coleta. Retornar resultado durável idempotente para resolver respostas perdidas.
4. Um coletor durável reivindica candidatos vencidos sob lock, verifica referências globalmente e muda para `deleting` antes de acessar SFTP. Novos vínculos a ativos nesse estado são proibidos pelo banco. Conferir raiz, caminho, propriedade e integridade; não seguir symlinks. Só então remover o arquivo. Repetir remoção ausente de modo idempotente.
5. Só confirmar `deleted` após sucesso. Falhas mantêm estado recuperável com tentativas, erro persistente e aviso de limpeza pendente separado de “fotos salvas”. Crash entre SFTP e banco é recuperado pela operação idempotente; nunca ressuscitar um caminho em exclusão.
6. Cancelamento/remoção de preparado podem antecipar elegibilidade, mas não autorizam `unlink` pelo navegador. Abandono/interrupção são cobertos pelo vencimento da lease e varredura de preparados sem vínculo. RPC ambígua não é sinal para apagar arquivos.

Isso exige registro/constraints/RPCs no banco e processamento durável. Pode aproveitar o worker existente com varredura limitada; alternativa é uma rotina agendada própria. O prazo de retenção (por exemplo 48 horas), frequência, política de tentativas e impacto operacional precisam de decisão antes de adicionar infraestrutura. Nenhuma rotina foi adicionada. Alternativa de menor acúmulo: preparar somente em memória e enviar os bytes ao salvar; muda o contrato de upload e limites de tamanho/tempo, ainda não resolve arquivos criados após gravação com resposta de banco ambígua.

## Verificação local e cobertura

- Novas regressões executam a ação real com banco/transporte simulados: recuperação pura com saldo, inclusão manual, exclusão manual, reordenação, preservação dos argumentos de atualização e saldo zero. O teste de saldo zero explicita a pendência geral ainda existente, não certifica o requisito de supressão futura.
- Testes de política cobrem produto sem imagens, origem/produto/IDs divergentes, comprovante adulterado/expirado, edição manual e ausência de comprovante.
- Regressões existentes cobrem falhas de download/VPS/banco com preservação de vínculos, preparação da capa, imagens externas/legadas, reordenação, estoque e transferência SFTP simulada.
- Suíte direcionada: 75 testes aprovados (74 na execução conjunta e o teste SFTP isolado após liberar conexão local de teste). A primeira tentativa direta sem o preload `server-only` e a tentativa SFTP no ambiente restrito falharam por configuração/permissão; foram corrigidas usando o runner do projeto e liberação exclusivamente do teste local.
- `npm run typecheck`: aprovado. `npm run build`: aprovado; aviso existente de depreciação do React 18 no Next 16.
- Os cenários de exclusão física após confirmação, bloqueio concorrente de referências, erro durável de coleta e expiração de preparados **permanecem pendentes**, assim como a ausência de fotos na reposição futura. A verificação não inclui banco ou arquivos reais.

## Publicação futura

Não publicar esta etapa como solução completa dos dois objetivos. Resolver as decisões estruturais acima e complementar os testes obrigatórios primeiro. O commit local usa `commit:smart` apenas para gerar metadados/commit; `check:smart` e `deploy:smart -- --dry-run` são verificações locais, sem `--execute`. O estado confirmado de deploy não foi editado.

Na publicação futura, recalcular o plano cumulativo contra o baseline confirmado, verificar os metadados do commit, validar testes/TypeScript/build e aplicar eventuais migrations aprovadas antes da aplicação. Executar Smart Deploy apenas na etapa autorizada e confirmar Vercel/worker conforme o plano. Esta entrega não está READY.
