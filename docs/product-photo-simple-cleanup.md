# Edição de fotos — exclusão simples após Salvar

Ponto de partida solicitado: `124738234948fb0e4fcc2eb064d12c79a2022024`.
Etapa exclusivamente local, sem push, migrations, deploy, acesso a dados de produção ou exclusão de arquivos reais.

## Regras implementadas

`marketplace_update_pending` e `syncListingsStock` continuam inalterados. Recuperação pura não inclui fotos no envio imediato; a reposição futura continua usando a pendência geral existente, inclusive o eventual reenvio das fotos. Não há coluna nova nem intenção separada.

`updateProductDetailsAction` chama `cleanupRemovedProductImages` depois do sucesso da substituição atômica e dos demais passos síncronos do salvamento/integrações. Se qualquer passo anterior falhar ou a RPC tiver resposta ambígua, não inicia limpeza. Confirmação de atividades externas continua assíncrona como antes.

O helper calcula removidas pela diferença de IDs entre o snapshot anterior e o conjunto final. Inclusão e reordenação sem remoção não apagam arquivos. Com removidas, relê IDs/posições do produto no Supabase e exige correspondência com o resultado esperado. Uma divergência bloqueia a limpeza.

Só considera URLs canônicas HTTPS da origem VPS e o formato já gerado pelo sistema: `produtos/<prefixo>/<hash-da-origem>/<posição>-<hash-do-conteúdo>.jpg`. O hash da origem precisa corresponder a `product-edit:<productId>` ou ao `source_key` do produto importado pelo Drive. Não modifica diretórios, SKU, posição ou nomes. URLs externas, Cloudinary, query strings, travessia de diretórios e arquivos legados sem evidência de propriedade são preservados. Não existe descoberta ou varredura retroativa.

Antes de excluir cada caminho, consulta globalmente `product_images` nas colunas `url`, `local_url`, `cloudinary_url` e `local_path`. Qualquer referência impede a exclusão, inclusive referência restabelecida no próprio produto. Erro ou resposta inconclusiva impede excluir aquele arquivo. Caminhos repetidos são deduplicados.

`deleteVpsImage` usa a mesma configuração SFTP e validação de fingerprint existentes. Exige o formato de caminho gerenciado, verifica com `lstat` todos os componentes do caminho absoluto, rejeita symlinks e objetos que não sejam diretórios/arquivo regular, limita o tamanho esperado e confere o hash do conteúdo antes do `unlink`. Não remove diretórios. Arquivo ausente é tratado de forma idempotente.

Falhas por arquivo são registradas com produto, caminho e erro; a rotina tenta os demais candidatos. A ação registra falhas de confirmação/limpeza e retorna erro explícito de “Fotos salvas; limpeza física não concluída”, sem mensagem falsa de sucesso nem rollback dos vínculos já confirmados. Não há retry automático nem fila nova.

O cliente não chama exclusão ao remover visualmente, cancelar ou sair. Uploads preparados descartados continuam sujeitos ao acúmulo existente; não foi introduzido ciclo de vida, coleta ou expiração. O endpoint DELETE de preparação continua desabilitado.

## Limitações aceitas pelo ajuste de escopo

- Verificar vínculos no Supabase e apagar no SFTP são operações separadas. Uma nova vinculação depois da consulta ainda pode concorrer com a exclusão. Não há garantia de serialização entre escritores, conforme a escolha explícita pelo fluxo simples.
- As consultas verificam as referências canônicas nas colunas existentes. Aliases externos que apontem para o mesmo arquivo não são inferidos.
- Falha de integração antes da limpeza, resposta ambígua da RPC ou erro de exclusão pode deixar arquivo sem vínculo. O diagnóstico fica no erro de salvamento/logs; não há coletor automático.
- Não há proteção adicional contra um administrador da VPS trocar componentes de diretório entre `lstat` e `unlink`. A raiz SFTP deve continuar sob controle administrativo do sistema.
- Arquivos históricos com nomenclatura/propriedade não comprovada são mantidos, mesmo após retirada do vínculo. Não há limpeza retroativa.

## Arquivos e funções

- `app/produtos/actions.ts`: `updateProductDetailsAction`, integração pós-salvamento e diagnóstico.
- `lib/product-image-cleanup.ts`: `ownedImagePath`, `cleanupRemovedProductImages`.
- `lib/vps-image-storage.ts`: extração de `withVpsSftp` preservando upload e adição de `deleteVpsImage`.
- `tests/product-image-cleanup.test.ts`: confirmação, propriedade, referências, inclusão/reordenação e falhas.
- `tests/product-photo-cancel.test.ts`: executa handlers reais do editor com hooks/ambiente simulados; remove visualmente e escolhe sair sem salvar, sem submissão nem requisição de exclusão.
- `tests/product-photo-recovery-flow.test.ts`: confirma chamada de limpeza somente após RPC, ausência de chamada nas falhas e mensagem de limpeza incompleta após fotos salvas.
- `tests/vps-image-storage.test.ts`: servidor SSH/SFTP efêmero local; upload, exclusão, idempotência, bloqueio de symlink, conteúdo divergente e travessia de caminho.
- Este relatório, nota de atualização do relatório anterior e plano cumulativo gerado pelo comando de commit.

## Validação e publicação futura

56 testes direcionados aprovados, mais o teste SSH/SFTP local aprovado. TypeScript aprovado. Nenhum teste usa o Supabase ou a VPS reais. Build local validado; aviso preexistente de depreciação do React 18 no Next 16.

O commit é criado somente por `npm run commit:smart`, com o baseline de produção confirmado existente (`daf83dab08fab5cec7f5ed8ff0ce5a7193e25e60`). O plano cumulativo inclui também a etapa anterior, ainda não publicada. Verificações posteriores: `npm run check:smart` e `npm run deploy:smart -- --dry-run`, sem `--execute`. Não editar o estado de deploy para mudar esse baseline.

Para publicação futura, revisar o plano cumulativo e aprovar o fluxo Smart Deploy. Confirmar testes, TypeScript, build, Vercel e eventual atualização do worker conforme classificação final. Não há migration ou dependência nova nesta etapa. A autorização deste pedido cobre somente implementação/testes/commit locais; não autoriza push, deploy ou reinício da VPS. Não declarar READY antes da confirmação de produção.
