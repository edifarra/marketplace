# Entrega do sistema

Foi montada uma base de sistema em Next.js + Supabase para substituir Google Sheets, Apps Script e Tiny ERP.

## Fluxo principal

1. O pipeline busca fotos no Google Drive.
2. Cada arquivo e validado pelo padrao usado no Apps Script: `TIPOMARCA_modelo-versao-codigo-especial_01`.
3. As fotos sao agrupadas por produto.
4. O produto e montado com as antigas abas `TIPO`, `MARCA`, `ESPECIAL`, `PRECO`, `MARKETPLACE` e `CONFIG_GERAL`, agora modeladas como tabelas do Supabase.
5. O SKU e gerado por grupo.
6. O produto e salvo no banco central.
7. O sistema cria ou enfileira anuncios no Mercado Livre e na Shopee.
8. A cada venda recebida por webhook, o estoque central baixa.
9. O estoque dos demais anuncios e sincronizado.
10. Se o estoque chega a zero, os anuncios sao pausados automaticamente.

## Arquivos principais

- `app/page.tsx`: painel com produtos, pipeline, configuracoes e integracoes.
- `lib/pipeline.ts`: regras vindas do Apps Script para fotos, SKU, templates e produto.
- `lib/inventory.ts`: baixa de estoque, sincronizacao e pausa automatica.
- `lib/marketplaces.ts`: conectores isolados de Mercado Livre e Shopee.
- `supabase/migrations/001_schema.sql`: estrutura do banco.
- `supabase/seed.sql`: carga inicial baseada na planilha.
- `.env.example`: variaveis de ambiente necessarias.

## O que falta para colocar em producao

- Preencher credenciais reais de Supabase, Google Drive, Cloudinary, Mercado Livre e Shopee.
- Completar assinatura/OAuth dos conectores de Mercado Livre e Shopee com as credenciais da conta.
- Rodar testes em sandbox antes de ativar anuncios reais.
- Importar todos os registros da planilha para as tabelas Supabase.
