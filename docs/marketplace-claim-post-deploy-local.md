# Correção local pós-deploy — Central de Reclamações ML

## Diagnóstico confirmado em 07/10/2026

A consulta somente leitura do caso 5589264783 e dos endpoints oficiais confirmou:
- O enriquecimento foi persistido em 07/10/2026 às 15:03:21 (Brasília), depois do baseline de deploy às 15:01:26.
- reason_name=repentant_buyer, reason com o texto oficial, reputation_impact=not_affected e billing info completos.
- Conversa isolada claim:5589264783 na conta correta; mensagem oficial com autor e horário persistidos.
- Timeline inclui venda, pagamento, postagem, transporte, entrega, abertura, mensagem e solução solicitada pelo comprador. Uma solução solicitada não comprova devolução ou reembolso realizado.

O estado atual não reproduz a ausência de dados mostrada na referência. A hipótese compatível com os horários é leitura anterior à reconciliação do worker. O defeito confirmado no código é que o header usa exclusivamente as props da lista, sem receber o snapshot mais recente carregado no detalhe. O detalhe também permanecia congelado até recolher/reabrir o caso.

## Correção

- Sincroniza o header com o snapshot persistido lido ao expandir e após ações.
- Reconsulta dados locais ao voltar para a janela e pelo botão Atualizar dados locais; sem consultas ML no detalhe.
- Descrição do motivo de arrependimento em terceira pessoa; preserva integralmente a mensagem original no chat.
- Seção Dados do comprador sempre presente após Gerais, com ausência de dados explícita.
- Nome público Prontolar Freguesia, apelido AKIPLACAS, razão social, CNPJ e endereço fiscal com complemento, CEP e país.
- Regras de reembolso/devolução e persistência existentes preservadas.

## Validação reproduzível, somente leitura

```
node --env-file=.env.local --require ./scripts/register-server-only.cjs --import tsx scripts/validate-marketplace-claim-detail.ts
npm run check:smart
npm run deploy:smart -- --dry-run
```

O script bloqueia métodos diferentes de GET/HEAD e hosts externos à API ML e ao Supabase configurado. Usa o token salvo, sem renová-lo, e não imprime credenciais nem dados pessoais. Compara o enriquecimento oficial com os dados persistidos, verifica a conta/claim, a mensagem e a cronologia.

## Reprocessamento e publicação futura

O caso 5589264783 já está enriquecido: não precisa de reprocessamento remoto. Casos abertos antigos continuam sendo reconciliados pelo worker existente (cinco por passagem, ordenados por updated_at). Casos fechados antigos incompletos não entram nessa rotina e precisam de enriquecimento direcionado pelo writer existente persistClaimBundle, sob autorização específica; abrir o detalhe não consulta ML nem escreve no banco. Não é necessária migration nova.

Impacto desta correção: Vercel sim; worker/VPS não; git pull VPS não; npm ci não; PM2 não. Nenhuma alteração de dependências. Somente correção local; publicação depende de nova conferência e autorização. A conferência visual final em produção permanece pendente.
