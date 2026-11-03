# Auditoria da edição de produtos e fotografias — 02/11/2026

Estado: correções locais; sem push, deploy, migration ou escrita em dados de produção. Base auditada: ef2ac083ad973ead0b926d67efdbb1ee2400ba9f. O estado local de deploy confirma essa base; o documento antigo do Drive ainda diz “local”, portanto não foi usado como prova de implantação.

## Diagnóstico e alterações

| Operação | Antes | Correção preparada |
| --- | --- | --- |
| Adicionar/trocar | Navegador enviava ao endpoint prepare; upload definitivo no Cloudinary. Troca era remover + adicionar. | Mesmo processador Sharp da criação: orientação EXIF, até 1200 px, proporção preservada, sem ampliar, JPEG qualidade 45; gravação imutável na VPS e verificação HTTPS. Troca continua remover + adicionar e só se efetiva ao salvar. |
| Recuperar do ML/Shopee | Download sem prazo e acumulado antes do limite; upload ao Cloudinary. | Download limitado durante leitura a 8 MiB e 30 s; processamento e armazenamento na VPS antes da troca. |
| Reordenar | Reenviava arquivos novos ao Cloudinary quando mudava a posição; uma mudança durante upload podia deixar o tratamento fora da sequência. | Ordem altera somente os vínculos na gravação. A capa é determinada pela posição final no envio, sem novo upload do original. |
| Remover/cancelar | Excluía recursos Cloudinary ao remover, abandonar ou após gravar; erro de RPC poderia levar à exclusão de um recurso já vinculado. | Remover exclui o vínculo somente na transação de salvar. Cancelar descarta a seleção. Nenhum arquivo definitivo é apagado; DELETE de prepare responde 405. |
| Dados enviados pelo navegador | URL, public ID e dimensões eram aceitos do formulário. | Comprovante HMAC assinado no servidor, válido por 24 h e vinculado ao produto e usuário; os metadados vêm desse comprovante, não dos campos editáveis. |
| Registros antigos | Recuperação temporária podia substituir automaticamente imagens indisponíveis ao salvar outros dados. | Detecção da conta dknfrkqol nas URLs, cloud name e public ID. Produtos com esses vínculos não passam por recuperação automática e ficam com a edição de fotos bloqueada no navegador e servidor. Demais dados continuam editáveis. |
| Publicação | Preparação da capa podia atualizar referências no Supabase. | Publicação de fotos bloqueada quando houver registro da conta desativada, sem gravar transformação sobre ele. Nos demais produtos, somente a capa usa Cloudinary; fotos secundárias usam a VPS. |

## Persistência e preservação

A RPC existente replace_product_images_atomically continua sendo utilizada: insere novas imagens antes de apagar os vínculos retirados e ajusta as posições na mesma transação. O formato atual aceita URL VPS e campos Cloudinary nulos sem migration. Para novas fotos da edição, a URL canônica, bytes e dimensões ficam no banco; local_url/local_path permanecem nulos, pois a RPC atual não os grava. O caminho completo pode ser obtido da URL canônica; os consumidores existentes priorizam essa URL VPS. A criação do Drive continua gravando também local_url/local_path.

A proteção aos 478 registros é por identidade da conta, sem depender de uma lista fixa de IDs. Nenhum desses registros foi consultado, alterado, migrado ou apagado em produção nesta tarefa. A quantidade 478 e os 146 produtos vêm do histórico fornecido, não de uma nova contagem. Para evitar até uma atualização intermediária de posição pela RPC, a sequência inteira de fotos de um produto protegido deve permanecer igual; isso também bloqueia adicionar fotos a esse produto enquanto vigorar a preservação.

Arquivos definitivos podem ficar sem vínculo após abandono ou falha. Não há limpeza automática: remover esses arquivos exigirá auditoria de referências, inclusive entre produtos clonados, e tratamento de respostas ambíguas do banco. O arquivo preexistente vps-legado-arquivos.txt ficou fora da alteração e do commit.

## Limites remanescentes

- A transação da RPC abrange apenas fotografias. Produto, estoque e filas continuam sendo atualizados em etapas; uma falha pode deixar dados parcialmente salvos, informada pela mensagem de erro existente.
- A RPC existente bloqueia as linhas de imagens, mas não compara uma versão da edição. Duas sessões concorrentes podem sobrescrever a seleção uma da outra. Uma proteção geral por versão exige evolução transacional do banco e não foi acrescentada nesta correção. O bloqueio dos produtos protegidos impede mudanças de fotos por este fluxo; outras rotinas administrativas do sistema não foram reescritas.
- Originais legados acessíveis continuam onde estão; não há migração em massa nesta edição. As fotos novas seguem a VPS e a capa é tratada na preparação de envio já existente.
- Limite de entrada permanece 8 MiB na edição (25 MiB no Drive). Os limites do provedor de hospedagem podem rejeitar uploads menores que 8 MiB antes de a rota receber o arquivo. Não se alterou o mecanismo de upload do navegador.
- O original servido é o JPEG processado, como na criação implantada; o arquivo bruto selecionado não ganha um arquivo separado de backup.
- A homologação autenticada no navegador, transferência à VPS real e envio real aos marketplaces dependem de ambiente autorizado; os testes usam arquivos sintéticos e serviços simulados.

## Arquivos

- app/api/products/images/prepare/route.ts: sessão ativa, armazenamento VPS e comprovante; exclusão física desabilitada.
- app/produtos/[id]/product-editor.tsx: comprovante, reordenação sem reenvio, máximo de seis arquivos, controles protegidos e textos do fluxo.
- app/produtos/[id]/page.tsx: repassa identificação dos vínculos protegidos.
- app/produtos/actions.ts: validação da sequência e comprovantes, recuperação para VPS, troca atômica e retirada da exclusão física.
- lib/product-photo-edit-policy.ts: política de preservação e assinatura/verificação de comprovantes.
- lib/marketplace-temporary-images.ts: impede recuperação automática em produtos protegidos.
- lib/prepare-marketplace-images.ts: bloqueia alterações de fotos protegidas no envio.
- tests/product-image-replacement.test.ts: cenários de preservação, sequência inválida, assinatura adulterada, usuário/produto incorretos, expiração e metadados de JPEG real.
- docs/product-photo-edit-audit.md: este diagnóstico.

Referências conferidas: https://supabase.com/docs/reference/javascript/rpc e https://supabase.com/docs/reference/javascript/using-modifiers-throwonerror . Sem mudança de esquema ou nova API Supabase.
