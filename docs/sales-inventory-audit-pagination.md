# Correção da leitura de auditorias em Vendas — 21/11/2026

## Causa raiz e evidências

A tela consultava venda, venda_item, venda_estoque_auditoria e products independentemente, sem paginação e ignorando erros. A Data API limita cada resposta a 1.000 registros. O banco tinha 1.031 vendas, 1.034 itens, 1.034 auditorias e 3.620 produtos. Assim, a ordenação recente das vendas era combinada com subconjuntos independentes de itens e auditorias, produzindo contagem zero e aviso falso de auditoria ausente/incompleta. A busca de títulos também era truncada.

O ID informado 200019687162358 não existe exatamente; a venda correspondente é 2000019687162358, UUID 7e2d222a-6fac-4adc-8356-88df1c16fe49. Ela tem uma unidade de 1328K2, reserva ativa, movimento VENDA_RESERVADA esperado e encontrado, estoque físico 1, disponível 0 e auditoria success. Na consulta antiga de venda_item, foram retornados 1.000 registros sem esse item; na leitura filtrada ele existe. A auditoria estava na primeira página, mas a ausência do item fazia expectedAuditCount ser zero e a tela rejeitava o sucesso.

Nenhuma das vendas do banco estava sem itens ou sem auditoria. Foram encontradas 773 auditorias success e 261 error: 259 com movimento ausente e 2 com produto/estoque não localizado. Essas falhas existentes são distintas do falso aviso generalizado e permanecem visíveis. Corrigi-las exige análise individual antes de qualquer movimento de estoque; nenhum saldo foi alterado nesta tarefa.

## Pipeline e vínculos

processMercadoLivreOrder envia os itens a registerMarketplaceSale. ensureProduct resolve os vínculos por conta/anúncio/variação e SKU; venda_item é persistida com o SKU canônico. A ingestão reconcilia o estoque via reconcile_sale_inventory e grava a auditoria via audit_sale_inventory. Para a venda de exemplo, item, produto, reserva e auditoria estão consistentes. Não foi necessário alterar essas regras ou reingerir pedidos.

## Correção

Todas as cinco leituras da tela passam por loadAllSalesRows, com páginas de 500 e ordenação determinística por id (preservando a prioridade de data nas vendas). Qualquer erro interrompe o carregamento em vez de transformar falha de consulta em ausência de itens/auditoria. Não altera critérios de aprovação, vínculos, movimentos, reservas, filas ou banco.

## Validação

- Três testes: 1.034 registros, limite exato de página e erros em leituras parciais/resposta nula.
- TypeScript e build de produção aprovados.
- Leitura real com a função corrigida: 1.031 vendas, 1.034 itens, 1.034 auditorias, 3.620 produtos; venda de exemplo com totalItems 1 e auditSucceeded true; 261 erros preservados.
- Build emitiu aviso de vulnerabilidade da versão atual do Next.js; atualização de dependências não integra esta correção.

Escopo: Vercel sim; worker/VPS não; migrations não; npm ci não; reprocessamento não. O carregamento completo mantém o comportamento atual da tela; paginação também da interface pode ser considerada separadamente conforme o volume crescer. As leituras não são uma transação única, como antes.
