# Auditoria e implementação: originais na VPS

Entrega local para revisão, sem push, deploy, migration, processamento real no Cloudinary, envio real aos marketplaces ou alteração de dados de produção. A consulta do SKU 1096AU e os HEADs das três URLs foram somente de leitura. Publicação em produção permanece pendente; esta entrega não é READY.

## Comportamento implementado

O seletor compartilhado prioriza `url` da VPS; durante a transição aceita `local_url` da VPS. Produtos legados continuam aceitando Cloudinary e caminhos antigos. A listagem e as miniaturas de reclamações tentam referências alternativas somente depois de falha de carregamento, terminando em “Sem foto”. Detalhes verificam a URL efetivamente selecionada antes de consultar marketplaces; a recuperação mantém todas as posições disponíveis e substitui somente posições indisponíveis que tenham fallback. Falhas isoladas na origem remota não descartam as outras fotos.

O envio ordena por `position`, exige posição 1 e posições únicas. Verifica a disponibilidade das originais; fotos 2–6 usam suas originais, ignorando derivados antigos. A Foto 1 usa identidade determinística SHA-256 da URL e dos bytes da original, com identificação do tratamento branco/remoção de fundo. O upload assinado usa incoming transformation e `overwrite=false`; persistência e disponibilidade do resultado precisam ser confirmadas antes de enviar. Um derivado válido indisponível bloqueia o envio sem repetir processamento. Mudança de conteúdo, URL ou foto principal invalida a correspondência anterior.

Legados com transformação explícita `e_background_removal,b_white` da mesma versão do asset podem reutilizá-la. Também se aceita a própria referência original legada quando ela já explicita ambos os efeitos. Uma URL preenchida sem essa evidência é insuficiente. Originais da VPS nunca usam essa inferência de correspondência com assets legados.

`cloudinary_url` recebe a transformação; `url`, `local_url` e `local_path` são preservados. Exceção de compatibilidade: se um legado tiver somente `cloudinary_url`, a referência antiga é preservada em `url` antes de registrar seu novo derivado. A escrita exige que posição e referências ainda correspondam ao snapshot lido. Não cria atividade de publicação por mudança interna de referência.

Na execução da fila, criações e atualizações que já têm intenção de enviar fotos reconstroem suas referências a partir do cadastro atual. Payloads antigos são corrigidos antes de qualquer chamada ao marketplace. Atualizações de preço, título ou estoque sem intenção de fotos não recebem fotos. O fluxo preexistente de atualização adiada por estoque continua vinculado ao salvamento manual anterior (`marketplace_update_pending`); uma simples troca de referências não ativa esse marcador.

## Matriz de auditoria

| Tela/Rotina | Arquivo/Função | Origem anterior | Nova origem | Resultado | Pendência |
|---|---|---|---|---|---|
| Listagem, pesquisa e capa | `app/produtos/page.tsx`, `ProductThumb` | Cloudinary > url > local_url | Seletor VPS, miniatura com fallback por falha | Corrigido e testado | Verificação visual autenticada após publicação |
| Detalhes do produto | `app/produtos/[id]/page.tsx` | Cloudinary > local_url > url | Original VPS; compatibilidade legada | Corrigido e testado | Verificação visual autenticada |
| Cadastro manual | `app/produtos/novo/actions.ts`, `product-form.tsx` | Cadastro de dados; fotos pelo editor | Mesmo fluxo | Compatível sem alteração | Uploads continuam no contrato legado |
| Editor, prévia e reordenação | `app/produtos/[id]/product-editor.tsx` | Recuperação substituía todo o conjunto | Mescla somente posições recuperadas; mantém as demais | Corrigido e testado | Salvar continua sendo atualização explícita de anúncios |
| Salvamento de recuperação | `app/produtos/actions.ts`, `updateProductDetailsAction` | Fotos remotas substituíam originais sem nova verificação | Confere disponibilidade da original novamente antes de baixar recuperação | Corrigido e testado | Origem de marketplace pode refletir ordem antiga; usuário revisa as fotos antes de salvar |
| Seleção compartilhada | `lib/product-image-source.ts` | Prioridades espalhadas | `url` VPS > `local_url` VPS > legado | Corrigido e testado | Hosts adicionais de armazenamento devem ser configurados conscientemente |
| Miniaturas com fallback | `app/components/product-thumbnail.tsx` | Sem fallback após erro | Mantém original até erro; tenta alternativas por imagem | Corrigido e testado | Fallback pode exibir derivado; não persiste nem publica |
| Recuperação temporária | `lib/marketplace-temporary-images.ts` | HEAD em cloudinary_url; uma falha recuperava tudo | HEAD/GET da URL selecionada; recupera somente posições ausentes | Corrigido e testado | Foto ausente sem fallback permanece ausente |
| Recuperação persistente automática | `lib/marketplace-image-recovery.ts` | Importava anúncio somente se cadastro não tivesse fotos | Mesmo bloqueio para qualquer conjunto existente | Compatível sem alteração | Armazenamento das novas recuperadas ainda Cloudinary, fora desta etapa |
| Botão Enviar, ML e Shopee | `lib/product-sender.ts`, `publishProductDirectly` | Metadados existentes; Cloudinary para todas as posições | Preparação compartilhada da Foto 1; originais nas demais | Corrigido e testado | Chamadas externas de criação não foram executadas |
| Atualização explícita de anúncios | `lib/direct-marketplace-publisher.ts`, `enqueueDirectListingUpdates` | Cloudinary para todas as fotos | Mesma preparação, apenas quando `changes.images` | Corrigido e testado | Confirmação real de atualização em cada marketplace pendente |
| Correspondência da transformação | `lib/product-marketplace-images.ts` | Campo cloudinary_url preenchido | Hash da original + política; evidência explícita para legado | Corrigido e testado | Download da capa é necessário para verificar mudança de conteúdo |
| Upload da transformação | `lib/cloudinary.ts`, `uploadMarketplaceCoverWithAccount` | Tratamento condicionado a uploads gerais | Upload separado da capa, assinado, não sobrescreve; valida metadados | Corrigido e testado | Teste externo do serviço/credenciais/remoção de fundo pendente |
| Persistência da transformação | `lib/prepare-marketplace-images.ts` | Sem vínculo verificável entre origem e derivado | Atualiza cloudinary_url com controle de concorrência | Corrigido e testado | Metadados de identificação antigos de Cloudinary não são reescritos; cleanup precisa distinguir os assets |
| Atividades antigas enfileiradas | `lib/outgoing-activities.ts`, `processOutgoingActivities` | URLs congeladas no payload antigo | Revalida a intenção de fotos e prepara referências atuais | Corrigido e testado | Atividades de criação já autorizadas continuam sendo executadas pelo worker quando publicado |
| Worker VPS e APIs de processamento | `scripts/marketplace-worker.ts`, `app/api/marketplace-queue/process`, `lib/marketplace-queue-worker.ts` | Worker executa saída e reconciliações | Worker herda a proteção da saída | Corrigido e testado | Publicar código e reiniciar PM2 somente em etapa autorizada |
| Upload Shopee | `lib/marketplaces/shopee/client.ts`, `uploadImageFromUrl` | URLs recebidas convertidas em image IDs | Recebe capa tratada e originais nas demais posições | Compatível sem alteração | Serviço externo não foi acionado |
| Confirmação de fotos ML | `lib/mercado-livre-picture-confirmation.ts`, `outgoing-activities.ts` | Compara fotos solicitadas com resposta/GET final | Mesmo comportamento sobre novas URLs | Compatível sem alteração | Processamento assíncrono do ML ainda exige confirmação real |
| Reposição e sincronização de estoque | `lib/inventory.ts`, `syncListingsStock` | Atualização completa apenas quando salvamento anterior ficou pendente | Mesmo gatilho; preparação corrigida quando já há intenção de fotos | Compatível sem alteração | Não altera imagens por simples mudança de referência interna |
| Painel/histórico de vendas | `app/vendas/page.tsx` | Foto do cadastro precedia anúncio da venda | Rota da imagem do anúncio/venda | Corrigido e testado | Capa do ML pode mudar historicamente se snapshot da venda não contiver imagem |
| Imagem da venda | `app/api/vendas/[id]/imagem/route.ts` | Shopee snapshot; ML consulta anúncio atual | Prioriza imagem ML do snapshot, depois consulta o anúncio | Corrigido e testado | Falhas terminam em placeholder; não troca por foto do cadastro |
| Chats, perguntas e atendimento | `app/chats-perguntas/conversation-grid.tsx`, `lib/marketplace-conversations.ts`, `marketplace-conversation-view.ts` | Mensagens, anexos e foto específica do anúncio/pedido | Mesmas referências de marketplace | Compatível sem alteração | Imagens ausentes de mensagens não são substituídas por fotos do cadastro |
| Cards de produtos Shopee no chat | `lib/shopee-message-product-cards.ts`, `shopee-conversation-reconciliation.ts`, `marketplace-special-messages.ts` | raw_data/product_image_url do anúncio | Mesmo contexto | Compatível sem alteração | Disponibilidade depende do CDN do marketplace |
| Reclamações/devoluções: foto de cadastro | `app/central-reclamacoes/case-display.ts`, `case-grid.tsx` | Cloudinary e restrição de host | VPS pelo seletor e fallback da miniatura | Corrigido e testado | Foto de contexto do cadastro continua distinta de evidências do comprador |
| Reclamações: consultas | `lib/marketplace-case-list.ts`, `marketplace-case-detail.ts` | Não selecionavam local_url | Incluem compatibilidade VPS transitória | Corrigido e testado | Nenhuma alteração nas associações de pedido/caso |
| Evidências de compradores | `app/central-reclamacoes/case-evidence.tsx`, `lib/marketplace-case-domain.ts` | URLs das evidências do marketplace | Mesma origem | Compatível sem alteração | Não devem ser trocadas por imagens do cadastro |
| Clonagem | `lib/product-cloner.ts`, `cloneProduct` | Preferia derivado Cloudinary | Download da original VPS quando migrada | Corrigido e testado | Clone ainda grava Cloudinary; reformulação explicitamente excluída |
| Tiny: criação/atualização | `lib/tiny.ts`, `buildTinyProductPayload`, `toTinyImageUrl` | Cloudinary > url > local_url | Original VPS pelo seletor; URLs VPS não são reescritas | Corrigido e testado | Integração pode propagar fotos por regras externas próprias; não foi executada |
| Pipeline/importação Drive | `lib/product-loader.ts`, `insertProductImages` | Upload e persistência Cloudinary | Mesmo fluxo | Pendente para etapa futura | Ainda não grava originais na VPS; não impede leitura de produtos migrados |
| API de preparação de upload | `app/api/products/images/prepare/route.ts` | Upload Cloudinary por posição | Mesmo fluxo | Pendente para etapa futura | Uploads não foram reformulados; capas já tratadas sem evidência recebem preparo conservador no envio |
| Administração de fotos Cloudinary | `app/fotos/page.tsx`, `listCloudinaryProductImages` | Inventário da conta Cloudinary | Mesmo inventário, explicitamente identificado na tela | Compatível sem alteração | Não é catálogo da VPS; transformações novas são associadas por URL |
| Exclusão administrativa de fotos | `app/fotos/actions.ts` | Pode apagar product_images por cloudinary_public_id | Não alterado; rotina não executada | Risco identificado | Não usar para limpar assets antigos de produtos migrados: pode remover referência VPS válida |
| Exclusão de produtos / limpeza | `lib/products.ts`, `lib/cloudinary-orphan-cleanup.mjs` | IDs/assets Cloudinary e remoção de cadastros | Mesmo comportamento, não executado | Risco identificado | Paths VPS e derivados novos precisam de lifecycle futuro; não excluir assets nesta etapa |
| Backfill de metadados | `scripts/backfill-product-image-metadata.mjs` | Prefere cloudinary_url e escreve metadados | Não executado | Pendente para etapa futura | Adaptar seleção antes de usar com migrados |
| Auditoria/publish avulso Shopee | `scripts/audit-shopee-publish-test.cjs` | Referências Cloudinary e opção --publish | Não executado; fora do fluxo normal | Risco identificado | Não usar --publish: ignora nova política, podendo enviar referências antigas |
| Regressão operacional 1122 | `scripts/regression-outgoing-1122.cjs` | Referências Cloudinary; operação específica | Não executado | Pendente para etapa futura | Atualizar antes de reutilizar para produtos migrados |
| Otimização legada Cloudinary | `scripts/cloudinary-legacy-optimize.mjs`, `cloudinary-stage2-global.mjs`, `cloudinary-stage2-pilot.mjs`, `cloudinary-stage2-interrupted-inspection.mjs`; respectivos `lib/cloudinary-*` | Assets/referências Cloudinary | Não executado | Pendente para etapa futura | Não usar para migrar ou inferir originais VPS; manter snapshots antigos como histórico |
| Cliente genérico legado | `lib/marketplaces.ts`, `getMarketplaceClient` | payload.images fornecido pelo chamador | Sem consumidores atuais encontrados | Risco identificado | Não reativar createListing sem preparação e contrato Shopee atual |
| API separada marketplace-api | `marketplace-api/src`, Prisma e docs | Configurações de integração; armazenamento descrito na documentação | Sem consumo operacional de product_images ou upload encontrado nesse subprojeto | Compatível sem alteração | Documentação descreve arquitetura futura, não novo armazenamento implementado |
| SQL e triggers de imagens | `supabase/migrations/004`, `065`, `081`, `085`, `091`, `093` | Campos locais existentes; replacement atômico; RLS service_role | Nenhuma alteração de schema/migration | Compatível sem alteração | Não foi encontrado trigger de publicação por UPDATE de url/cloudinary_url nas migrations auditadas |

## SKU 1096AU e reversão

`1096AU-before.json` preserva IDs, posições, nomes, `url`, `local_url`, `local_path` e `cloudinary_url` consultados. As três URLs públicas retornaram HTTP 200 com `image/jpeg`. A transição já funciona com `local_url`, sem UPDATE para exibir as originais.

`1096AU-forward.sql` prepara somente a troca de `url` para as três originais da VPS. `1096AU-rollback.sql` restaura as três referências anteriores. Ambos validam as posições, IDs e campos do snapshot, bloqueiam linhas durante a transação e terminam em ROLLBACK por padrão. Não limpam campos de compatibilidade nem derivados. Nenhum desses SQLs foi executado; uma futura execução exige revisão do snapshot e autorização própria. A primeira capa VPS enviada precisará de transformação vinculada à original atual; não se presume validade do derivado Cloudinary antigo.

`scripts/prepare-vps-image-review.mjs` é a ferramenta somente de leitura usada para gerar esses arquivos. Ela não contém chamadas de escrita no banco ou nos marketplaces. Seus SQLs são texto de revisão.

## Testes e limites da comprovação

- Testes locais de seleção VPS/legado/misto, URL ausente, fallback, erro isolado, correspondência da transformação, falha de tratamento/persistência, reordenação, fontes secundárias e snapshot do SKU.
- Testes de preparação dos payloads de criação e atualização para ML e Shopee, referências antigas enfileiradas e ausência de inserção de fotos em atividades sem essa intenção.
- Teste do upload Cloudinary com HTTP simulado: assinatura, incoming transformation, branco, remoção de fundo, identidade determinística e overwrite=false.
- Regressões de recuperação, replacement atômico, estoque, confirmação ML, pós-processamento da fila e consultas/layout de reclamações.
- Compilação de produção local e verificações Smart após commit, com dry-run sem publicação.

Os mocks não comprovam processamento real da imagem nem aceitação dos marketplaces. O teste SQL de revisão não foi executado. Não houve teste de interface autenticada em produção. As validações reais realizadas foram SELECT do SKU e HEAD das três originais VPS. A execução externa de Cloudinary, envio, atualização e confirmação de anúncios permanece pendente por restrição expressa do pedido.

Riscos restantes: metadados preexistentes podem representar o asset antigo, não o arquivo VPS; falhas de rede bloqueiam envio com segurança; URLs legadas sem prova de tratamento recebem uma transformação conservadora; a verificação por bytes exige download da Foto 1; mudança de imagem concorrente imediatamente após a preparação não pode ser eliminada por uma transação envolvendo serviços externos. Operações administrativas de exclusão e scripts antigos devem ser revisados antes de uso com migrados. Nenhuma exclusão foi realizada.

## Impacto operacional para publicação futura

- Impacta Vercel? **Sim**.
- Impacta o worker da VPS? **Sim** (`outgoing-activities` é importado pelo worker).
- Precisa `git pull` na VPS? **Sim, quando a publicação for autorizada**.
- Precisa `npm ci`? **Não**; package.json e package-lock.json não mudaram.
- Precisa `pm2 restart marketplace-worker --update-env`? **Sim, quando a publicação for autorizada**.
- Migration de schema? **Não**. UPDATE controlado do SKU? **Preparado, não executado; opcional para leitura transitória**.

Comandos requeridos numa futura publicação, não executados nesta entrega:

```bash
cd /opt/gestao-marketplace
git pull origin main
pm2 restart marketplace-worker --update-env
pm2 status marketplace-worker
```

O hash e a lista exata de arquivos do commit são informados no encerramento desta revisão; os resultados finais de validação ficam em `validation.md`.
