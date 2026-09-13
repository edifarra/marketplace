# Cloudinary — Etapa 2: diagnóstico do piloto

Data: 2026-09-13

## Decisão

O piloto destrutivo está **BLOQUEADO**. Nenhum asset foi sobrescrito. Os três candidatos permitem backup binário local exato (download + SHA-256), mas a Admin API retornou `backup=false` e nenhum histórico de versões para todos eles. Sem restauração nativa habilitada e sem um teste destrutivo prévio em asset descartável com o mesmo padrão de URL, não há rollback tecnicamente comprovado para esta conta.

## Modelo atual

- `product_images` persiste `url`, `cloudinary_url`, `cloudinary_public_id`, `cloudinary_asset_id` e `cloudinary_cloud_name`.
- Há URLs transformadas e sem versão, e URLs transformadas com `/v<timestamp>/`.
- `product_marketplaces.raw_data`, `listings` e conversas guardam snapshots/URLs devolvidos pelos marketplaces, não uma segunda chave Cloudinary administrável pelo sistema.
- Mercado Livre recebe `pictures[].source`; Shopee recebe `image.image_url_list`; Tiny recebe `imagens_externas` e `anexos`. Esses envios usam as URLs de `product_images` no momento da publicação/atualização.
- Os snapshots atuais indicam que Mercado Livre e Shopee mantêm URLs/CDNs próprios após a ingestão. O executor não atualiza nem reenvia anúncios.

## Overwrite, versões e cache

- Upload com `overwrite=true` e o mesmo `public_id` substitui o asset lógico e incrementa a versão.
- A documentação define `asset_id` como identificador único e imutável; o executor exige que ele permaneça igual e aborta/aciona rollback se divergir.
- URLs com a versão nova fazem cache-busting imediato. URLs sem versão podem continuar entregando cache antigo até expirar, salvo `invalidate=true`.
- URLs persistidas com versão antiga precisam de validação explícita. Com `invalidate=true`, Cloudinary documenta invalidação da versão anterior, mas o efeito depende da configuração de invalidação e pode levar minutos. O sistema não atualiza URLs no banco nesta etapa.
- Assets e derivados em CDN podem permanecer em cache por até 30 dias. `invalidate=true` será obrigatório em eventual overwrite.
- A documentação não afirma que overwrite elimina derivados armazenados. A decisão segura é tratá-los como persistentes até medição pós-piloto; eles podem ser recriados sob demanda pelas mesmas URLs transformadas, mas nenhuma exclusão em massa é autorizada.
- Versões de backup, quando habilitadas, contam para storage (especialmente no plano Free). Portanto overwrite não deve ser presumido como redução líquida imediata enquanto versões anteriores estiverem retidas.

## Política proposta

- Maior lado: 1200 px, mantendo aspect ratio e sem upscale.
- JPEG: qualidade 88, progressivo, MozJPEG, chroma 4:4:4.
- PNG: permanece PNG, compressão lossless nível 9; transparência preservada.
- Auto-rotação por EXIF e remoção de metadados no arquivo produzido.
- Uma única recompressão a partir do original baixado; nunca reutilizar uma saída otimizada como entrada.

## Resultado do dry-run

- Candidatos inequívocos atuais: 860.
- Originais: 1.841.552.017 bytes (1.756,24 MiB).
- Estimativa pós-otimização: 468.222.361 bytes (446,53 MiB).
- Economia projetada: 1.373.329.656 bytes (1.309,71 MiB), 74,57%.
- A projeção total usa a razão média das três amostras reais; não é uma medição dos 860 arquivos.
- O endpoint de listagem em massa não devolveu os derivados por asset. Nos três detalhes consultados: 4 derivados, 243.865 bytes. O total dos 860 permanece desconhecido e bloqueia uma afirmação confiável sobre economia total incluindo derivados.

## Amostras selecionadas

1. `produtos/LG/1239KTKT_32LN5400_02`: JPEG 3024×4032, 806.817 → 126.788 bytes (−84,29%). Faixa leve; produto enviado, anúncios pausados.
2. `produtos/LG/815PFPF_65NANO81SNA_EAX68248021_02_2dedb9ca58`: JPEG 4032×3024, 2.093.624 → 231.305 bytes (−88,95%). Faixa média; anúncios ativos em Mercado Livre e Shopee.
3. `produtos/LG/816PFDPF_55QNED80SRA_EAY65895417_04_8801e764b0`: PNG 1086×1448, 3.615.370 → 1.790.100 bytes (−50,49%). Faixa pesada/formato distinto; anúncios ativos em Mercado Livre e Shopee.

Todas as URLs persistidas das três amostras responderam HTTP 200 antes do piloto. Nenhum registro de banco, produto, token, anúncio ou asset foi alterado.

## Próxima condição para liberar o piloto

Habilitar e confirmar backup/versionamento nativo no Cloudinary, validar restore por `version_id` em um asset descartável que reproduza URLs versionadas e sem versão, e confirmar a política de retenção/custo dos backups. Só então executar novamente com `--execute --limit=3`.
