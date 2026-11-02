# Fotografias do Drive na criação de produtos

Implementação local. Não foi feito deploy, aplicada migration, configurada a VPS ou alterado dado de produção.

## Verificação de arquitetura antes da implementação

A criação de produtos roda em funções Next.js na Vercel, não no processo PM2. Gravar em `public/` dessa função não cria armazenamento persistente na VPS. A aplicação também não dispunha de um serviço privado de ingestão de imagens. O worker atual processa atividades de marketplaces, não esses arquivos.

Foi escolhida transferência SFTP iniciada pelo servidor Next.js. O OpenSSH da VPS é o serviço de armazenamento; não há uma nova API HTTP de upload, URL assinada de gravação nem credencial enviada ao navegador. O domínio público continua fornecendo somente leitura por HTTPS. Isso exige conectividade TCP de saída Vercel → porta SSH da VPS e provisionamento de uma identidade exclusiva. A viabilidade do runtime foi verificada na documentação; a conectividade com a VPS real ainda deve ser homologada depois de autorizada.

Referências: [runtime Node.js da Vercel](https://vercel.com/docs/functions/runtimes/node-js), [limites das funções](https://vercel.com/docs/functions/limitations), [cliente ssh2 e validação do host](https://github.com/mscdex/ssh2), [SFTP](https://github.com/mscdex/ssh2/blob/master/SFTP.md), [restrições OpenSSH](https://man.openbsd.org/sshd_config).

## Processamento e persistência

1. A ordenação numérica existente das fotos é mantida; até seis fotos são baixadas sequencialmente. Só a criação passa limites explícitos ao download: 25 MiB e 30 segundos por arquivo.
2. Sharp aplica a orientação EXIF, limita a 1200 × 1200, mantém proporção, não amplia e gera JPEG com qualidade 45. Não há remoção de fundo nessa etapa. São rejeitados arquivos vazios, corrompidos, animados, não fotográficos ou acima de 40 milhões de pixels.
3. Cada arquivo recebe o caminho `produtos/<prefixo>/<SHA256 source_key>/<posição>-<SHA256 JPEG>.jpg`. Nomes do usuário nunca viram caminhos; posições, fontes e conteúdos diferentes não colidem. A mesma entrada e versão do Sharp produzem o mesmo nome.
4. O upload usa um `.UUID.part` exclusivo e verifica os bytes via SFTP antes de renomear. Um destino já existente só é reutilizado quando seu hash corresponde. Há prazo máximo de 60 segundos por sessão e validação obrigatória da chave do host.
5. O arquivo definitivo também é baixado pelo HTTPS público e comparado byte a byte por hash. Sem correspondência, não é referenciado pelo banco. O Nginx não deve transformar esses JPEGs.
6. Uma única RPC grava produto, `product_images` e anúncios internos em transação. Ficam registrados URL HTTPS, caminho relativo, posição, dimensões e bytes do JPEG real; campos Cloudinary ficam nulos. Não existe fallback que descarte metadados. O produto continua `pending_price`, com preço zero, e os anúncios ficam `draft`, por conta ativa, preservando a precificação posterior.
7. Lock transacional por `source_key` e a restrição única existente impedem duplicação. Uma chamada repetida retorna o produto existente sem reescrever suas fotos. Falhas em imagens ou anúncios revertem todos os inserts da transação. Apenas `service_role` pode executar a RPC, com `security invoker`.
8. A preparação existente para ML e Shopee permanece: somente a foto 1 passa por remoção de fundo e fundo branco no Cloudinary; as fotos 2–6 usam as URLs originais da VPS. Edição, clonagem e recuperação continuam com seus próprios fluxos existentes.

Referências Sharp: [redimensionamento](https://sharp.pixelplumbing.com/api-resize/), [orientação](https://sharp.pixelplumbing.com/api-operation/), [JPEG](https://sharp.pixelplumbing.com/api-output/). Persistência: [RPC Supabase](https://supabase.com/docs/reference/javascript/rpc).

## Configuração necessária antes da implantação

Segredos exclusivamente no ambiente servidor da Vercel, sem prefixo `NEXT_PUBLIC_`:

| Variável | Conteúdo |
| --- | --- |
| `VPS_IMAGES_SFTP_HOST` | Host/IP SSH acessível à Vercel |
| `VPS_IMAGES_SFTP_PORT` | Porta SSH; padrão 22 |
| `VPS_IMAGES_SFTP_USER` | Usuário dedicado de imagens |
| `VPS_IMAGES_SFTP_KEY_BASE64` | Chave privada PEM codificada em base64 |
| `VPS_IMAGES_SFTP_HOST_SHA256` | SHA256 hexadecimal de 64 caracteres da chave pública SSH do servidor, validada por canal confiável; não é a representação base64 de `ssh-keygen -lf` |
| `VPS_IMAGES_SFTP_ROOT` | Diretório absoluto visível dentro do chroot, previamente criado; exemplo `/Imagens` |

O chroot e seus ancestrais devem pertencer ao root e não ser graváveis pelo usuário. Apenas seu subdiretório de imagens deve ser gravável. O usuário deve ter `ForceCommand internal-sftp`, autenticação somente por chave, sem shell, sem encaminhamento TCP/agente, sem terminal e sem acesso ao código ou aos segredos da aplicação. Exemplo de configuração a revisar com o administrador, sem executá-la nesta tarefa:

```text
Match User marketplace-images
    ChrootDirectory /srv/marketplace-images
    ForceCommand internal-sftp
    AuthenticationMethods publickey
    PasswordAuthentication no
    DisableForwarding yes
    PermitTTY no
```

Exemplo de mapeamento no virtual host HTTPS já existente (adaptar ao diretório real, preservar `/Imagens/Legado/` e demais regras atuais):

```nginx
# Ocultar arquivos incompletos antes das regras que servem arquivos estáticos.
location ~ ^/Imagens/produtos/.*\.part$ { return 404; }
location /Imagens/produtos/ {
    alias /srv/marketplace-images/Imagens/produtos/;
    autoindex off;
    limit_except GET HEAD { deny all; }
    add_header X-Content-Type-Options nosniff always;
}
```

A location de imagens deve servir `image/jpeg`, sem autenticação para leitura, sem redimensionamento/recompressão e sem publicar a área de temporários. As regras regex preexistentes do Nginx precisam ser conferidas. Garantir volume persistente, espaço livre, backup e restauração; nenhuma limpeza deve apagar os arquivos definitivos referenciados.

A migration `20261102232000_atomic_drive_product_creation.sql` está apenas preparada. Aplicá-la, após autorização, antes de publicar a aplicação. Ela pressupõe as migrations anteriores do repositório, incluindo metadados de imagens e contas dos anúncios. Instalar dependências com `npm ci`; `ssh2` é externalizado no bundle Next.js.

## Falhas, limpeza e riscos operacionais

- `finally` remove exclusivamente o `.part` gerado pela chamada. Não há temporário de imagem no disco local da Vercel. Se a conexão cair ou o processo for encerrado, a remoção pode não chegar à VPS: provisionar limpeza periódica apenas de arquivos com o padrão gerado `posição-hash.jpg.UUID.part`, com mais de 24 horas. A limpeza não deve seguir links simbólicos, tocar arquivos `.jpg` ou percorrer diretórios fora de `Imagens/produtos`. Essa rotina é dependência operacional e não foi instalada.
- Arquivos definitivos sem referência podem permanecer após falha do banco, corrida, interrupção da função ou mudança do conteúdo. Não são apagados automaticamente: timeout não prova rollback. Uma futura coleta de órfãos precisa consultar todas as referências, considerar chamadas em andamento e exigir confirmação. Essa preservação é intencional.
- O pipeline continua síncrono. Lotes grandes ou rede lenta podem exceder a duração total da função Vercel; os prazos por arquivo não ampliam esse limite. Homologar o plano e o tamanho de lote antes da publicação. Reexecução não duplica produto confirmado; reserva de SKU pode deixar lacunas como no fluxo existente.
- Uma falha ao mover fotos no Drive depois do commit mantém o produto completo. A próxima execução reconhece a fonte existente e utiliza o tratamento de duplicados já existente. Produtos legados incompletos não são reparados por essa mudança.
- `force=1` não ignora mais autenticação na criação. O proxy remove qualquer `x-dashboard-authenticated` do cliente e só o recria após validar sessão ativa. Sem sessão, as rotas exigem `CRON_SECRET`; não configurar esse segredo não abre acesso.
- O worker de marketplaces não recebe lógica nova de criação. Como o manifesto/lockfile mudaram, o Smart Deploy classifica também atualização das dependências na VPS. Provisionamento SFTP/Nginx é separado do restart PM2.
- Os testes usam arquivos sintéticos, armazenamento simulado e PostgreSQL PGlite isolado. Falta homologação real Vercel → SFTP → Nginx e Supabase autorizado. Não foi testado o firewall nem o mapeamento do host de produção.

## Verificação local

```text
node scripts/smart-test-runner.mjs tests/drive-photo-processing.test.ts tests/vps-image-storage.test.ts tests/product-loader-drive.test.ts tests/drive-product-auth.test.ts tests/drive-product-creation-sql.test.mjs tests/product-vps-images.test.ts tests/cloudinary-upload-policy.test.ts tests/marketplace-image-recovery.test.ts tests/product-image-replacement.test.ts tests/marketplace-stock-reactivation.test.ts tests/smart-test-runner.test.mjs
npm run typecheck
npm run build
```

O runner instala PGlite fixado em pasta temporária, sem modificar as dependências do projeto e sem conectar ao Supabase. A migration é executada somente nesse banco efêmero para testar rollback, posições, bytes, dimensões, idempotência e permissões. Após o commit, executar `npm run check:smart` e `npm run deploy:smart -- --dry-run`; o dry-run não publica nem altera produção.
