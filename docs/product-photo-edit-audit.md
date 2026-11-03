# Correção da edição e recuperação de fotografias

Este relatório substitui o diagnóstico anterior associado ao commit 5c956736e640aea4fd1e744e8ec8272e232ad7c8. A regra que bloqueava fotografias por conta Cloudinary foi removida. A origem da conta não é critério de autorização, recuperação ou publicação.

## Comportamento corrigido

- A verificação normal de disponibilidade permanece. Imagens disponíveis continuam cadastradas e não provocam consultas aos marketplaces para recuperação.
- Imagens indisponíveis voltam ao mecanismo existente recoverTemporaryImagesWhenCloudinaryIsUnavailable. A recuperação consulta apenas anúncios associados ao produto, prioriza contas Shopee e depois ML conforme a rotina já existente e seleciona somente posições indisponíveis. O preview é temporário e não grava no banco.
- Na edição, mergeRecoveredImages preserva as posições existentes e substitui somente as selecionadas pela recuperação. O operador pode remover, substituir e reordenar antes de salvar. Nenhum controle depende de cloud name ou public ID.
- No salvamento, resolveMarketplaceRecoveryImageUrls confirma novamente o vínculo produto + marketplace + conta + anúncio. O download continua limitado a 8 MiB e 30 segundos. Sharp e armazenamento VPS são os mesmos já utilizados: EXIF, máximo 1200 px, sem ampliar, JPEG qualidade 45 e nome imutável por hash.
- As gravações SFTP e a verificação HTTPS continuam anteriores à troca atômica das fotografias. Falha de download, armazenamento ou transação mantém os vínculos anteriores. Nenhum arquivo físico é apagado.
- Reordenar uma imagem já persistida modifica somente a posição do vínculo. A preparação existente de publicação usa a posição final para gerar/reutilizar a capa de fundo branco, identificada pelo original e conteúdo. Fotos secundárias mantêm suas URLs.
- Uploads manuais continuam com sessão ativa e comprovante HMAC vinculado ao produto e usuário. A validação da sequência ainda exige 1–6 entradas únicas e impede referências a imagens de outro produto.
- A preparação de publicação deixa de rejeitar produtos pela conta Cloudinary anterior. As verificações normais de disponibilidade e de sucesso do tratamento permanecem: retirar o bloqueio por conta não torna uma fotografia indisponível publicável sem recuperação.

## Arquivos alterados e revisados

Alterados:

- lib/product-photo-edit-policy.ts: remove identificação e bloqueio da conta; mantém validação estrutural e HMAC.
- lib/marketplace-temporary-images.ts: remove retorno antecipado e exclusão das posições da conta desativada.
- lib/prepare-marketplace-images.ts: remove rejeição de publicação por origem Cloudinary.
- app/produtos/[id]/page.tsx: deixa de repassar indicador de bloqueio.
- app/produtos/[id]/product-editor.tsx: remove restrições de adicionar, excluir e mover e mensagem de bloqueio.
- tests/product-image-replacement.test.ts: verifica operações permitidas com URLs da conta antiga e mantém regressões de HMAC e sequência.
- tests/product-photo-recovery-flow.test.ts: executa as rotinas existentes de recuperação, ação de salvar e preparação de publicação com dependências externas simuladas.
- docs/product-photo-edit-audit.md: atualiza este diagnóstico.
- .smart-deploy-plan.json: regenerado pelo comando de commit; preserva o baseline real confirmado.

Revisado sem mudança: app/produtos/actions.ts. Já utiliza VPS, confirma origem do anúncio, autentica uploads e só chama replace_product_images_atomically após armazenar todas as imagens novas. Não havia nele bloqueio adicional fora da política compartilhada removida.

## local_url e local_path

A criação do Drive grava url, local_url e local_path. A RPC existente de edição 091 grava url e os metadados, mas não possui local_url/local_path no INSERT. As colunas já existem; a diferença está na função, não no esquema de tabelas. Apenas acrescentar esses campos ao JSON do cliente não os persistiria.

Nesta correção não se alterou a RPC nem se criou migration ou segunda escrita após a troca. A URL VPS canônica permanece suficiente para os leitores existentes e contém o caminho relativo. local_url e local_path continuam nulos para novas fotos da edição; os valores das imagens existentes são mantidos. Padronizar fisicamente esses dois campos exige uma futura atualização versionada da função, se desejada, para preservar a atomicidade. Não foi introduzida migration apenas para essa padronização.

## Validações locais

A suíte nova verifica:

1. Fotos disponíveis, inclusive da conta antiga, sem recuperação ou consultas ao banco.
2. Recuperação de posição indisponível via Mercado Livre e Shopee sem substituir a secundária válida.
3. Falha de recuperação com preservação das referências e rejeição de anúncio não vinculado antes de consultar o marketplace.
4. Salvamento real da ação com processamento Sharp: armazenamento precede RPC; referência recuperada recebe URL VPS e posição 1; secundária válida permanece.
5. Reordenação após recuperação sem novo upload; operações e RPC limitadas ao produto selecionado.
6. Falhas de download, VPS e banco sem perda dos vínculos anteriores.
7. Atualização da identidade da capa tratada ao trocar a primeira foto, preservando URL secundária.
8. Preparação de publicação aceita original disponível da conta antiga e limita a gravação da derivada à imagem/capa selecionada.
9. Validação de sequência, referência a outro produto, HMAC adulterado, expiração e usuário/produto incorretos.

São testes com banco, marketplaces e transporte simulados; não são homologação nos serviços reais.

## Restrições respeitadas e limites

Sem push, deploy, migrations, limpeza física ou alterações em produção. Não há operação em massa sobre os 478 registros. A recuperação só atua nos produtos abertos/editados e somente quando a fotografia está indisponível; não existe regra por identidade da conta.

Continuam os limites anteriores: não há controle de versão para duas edições simultâneas; a transação de fotos não abrange dados do produto, estoque e filas; arquivos definitivos podem ficar sem vínculo após abandono/falha; o limite de upload do provedor pode ser inferior aos 8 MiB aceitos pela aplicação. A correspondência de recuperação é comprovada pelo vínculo do anúncio e posição da fotografia, sem reconhecimento visual automático do conteúdo. A recuperação mantém a estratégia atual de primeira origem com imagens recuperáveis; não foi reimplementada para combinar imagens de diversas contas.

## Implantação futura — não executada

Impacta Vercel? Sim.
Impacta o worker da VPS? Sim, por módulos compartilhados.
Precisa git pull na VPS? Sim, na implantação aprovada.
Precisa npm ci? Não, dependências inalteradas.
Precisa pm2 restart marketplace-worker --update-env? Sim, na implantação aprovada.
Precisa migration? Não.

Após autorização e publicação do código, a atualização do worker exigirá:

```bash
cd /opt/gestao-marketplace
git pull origin main
pm2 restart marketplace-worker --update-env
pm2 status marketplace-worker
```

Nenhum desses comandos foi executado nesta tarefa. Produção permanece pendente; não se declara READY.
