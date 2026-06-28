# Sistema de estoque e marketplaces

Base Next.js + Supabase para substituir Google Sheets, Apps Script e Tiny ERP no fluxo de fotos, produtos, estoque e anuncios.

## O que ja esta modelado

- Coleta de fotos do Google Drive.
- Validacao do padrao de nomes usado no Apps Script.
- Agrupamento de fotos por produto.
- Busca de tipo, marca, especial, preco e categorias em tabelas Supabase.
- Geracao de SKU por grupo.
- Criacao do produto no sistema.
- Fila de publicacao para Mercado Livre e Shopee.
- Webhooks de venda para baixar estoque.
- Sincronizacao de estoque nos demais marketplaces.
- Pausa automatica de anuncios quando o estoque chega a zero.
- Telas de configuracao para substituir as abas da planilha.

## Como rodar

1. Preencha `.env.local` usando `.env.example`.
2. Crie o banco no Supabase com `supabase/migrations/001_schema.sql`.
3. Carregue dados iniciais com `supabase/seed.sql`.
4. Instale dependencias e rode:

```bash
npm install
npm run dev
```

## Rotas principais

- `/` painel operacional e configuracoes.
- `/api/pipeline/run` executa coleta/processamento em lotes.
- `/api/webhooks/mercado-livre` recebe eventos de venda do Mercado Livre.
- `/api/webhooks/shopee` recebe eventos de venda da Shopee.

## Observacao importante

Os conectores de Mercado Livre e Shopee estao isolados em `lib/marketplaces.ts`. Eles ja deixam claro onde criar, atualizar estoque e pausar anuncios. Para producao, complete a assinatura OAuth/assinatura HMAC conforme as credenciais da conta e valide em ambiente sandbox antes de ativar vendas reais.
