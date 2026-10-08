# Central de Reclamações — revisão local

Sem deploy, push, atualização de VPS, PM2, migrations, instalação de dependências ou alteração de serviços externos.

## Auditoria da implementação

- `lib/marketplaces/shopee/client.ts`: endpoint existente `GET /api/v2/returns/get_return_detail`, por `return_sn`.
- `lib/marketplace-case-enrichment.ts`: detalhe obtido pelo worker existente e identidade conferida. A abertura da tela lê apenas o banco local.
- `lib/marketplace-case-domain.ts`: normaliza `reason`/`reason_code`, `reason_text`, `text_reason`, `refund_amount`, `currency`, `return_status`/`status`, `stage`, prazos, logística reversa e referências textuais de `image`.
- `persist_marketplace_case`: persiste snapshot normalizado em observações; estado e campos centrais na tabela de casos; demais atributos em `content`; fotos em `marketplace_case_evidence`. O JSON completo do detalhe não é preservado nessa estrutura.
- Valor do reembolso e moeda já eram persistidos, mas não selecionados pelo detalhe da tela. Agora são projetados no SELECT existente, junto de `stage`, sem nova consulta.
- Resultado solicitado e vídeos não são normalizados/persistidos pela integração atual. Sua presença no payload de casos reais não foi verificada: não se consultou produção. A documentação oficial https://open.shopee.com/documents/v2/v2.returns.get_return_detail?module=102&type=1 retornou HTTP 403. Não foi adotado contrato de fontes não oficiais.

## Implementação

Header existente preservado, com motivo Shopee legível e fallback para código desconhecido, sem inventar tradução. Chat e contexto anterior ML ficam na coluna esquerda. Dados Gerais, comprador e Timeline ficam na direita, nessa ordem. Em telas menores, as colunas se empilham; header deixa de impor largura mínima de 960px.

Chat Shopee apresenta reembolso, motivo, descrição e evidências já persistidas. Resultado solicitado indisponível é explicitamente sinalizado. Fotos com URL HTTPS são exibidas e abertas para ampliação; referências opacas permanecem indisponíveis para prévia. O componente também aceita evidências de vídeo já persistidas, com controles e sem autoplay, mas a sincronização atual não as produz. Não há URL de CDN fabricada nem conversão remota de referências.

Dados Gerais, produtos, quantidade, SKU, valores, comprador, prazos, rastreamento e ações existentes foram preservados. Modalidade persistida de logística reversa passa a ser exibida quando disponível. Não se copia logística, destinatário ou chat normal como dados oficiais da solicitação.

Timeline ML mantém o array e sua ordem, todos os eventos e campos anteriores. Somente título Timeline pode ter negrito; eventos, datas e campos usam peso normal.

## Mapeamento conservador Shopee

Exatamente quatro etapas; atual laranja, concluída verde, pendente cinza e ausência de confirmação indicada por `?`.

| Evidência persistida | Etapa atual |
| --- | --- |
| CLOSED ou CANCELLED | Solicitação finalizada |
| stage = seller_validation | Em validação pelo vendedor |
| stage = awaiting_buyer_shipping, waiting_for_buyer_shipping ou ready_to_ship | Pendente comprador postar devolução |
| logística reversa = LOGISTICS_NOT_START, LOGISTICS_READY, LOGISTICS_REQUEST_CREATED ou LOGISTICS_PICKUP_PENDING, acompanhada de prazo oficial de postagem pelo comprador | Pendente comprador postar devolução |
| REQUESTED, sem evidência mais específica acima | Comprador solicitou Devolução/Reembolso |
| PROCESSING, ACCEPTED, JUDGING, SELLER_DISPUTE, demais estados ou ausência de campos sem evidência específica | Etapa atual sem confirmação |

Encerramento não comprova postagem ou validação: etapas intermediárias puladas ficam sem confirmação. Entrega logística não comprova validação pelo vendedor. Etapas intermediárias só ficam concluídas quando há registro daquela etapa e estado atual posterior inequívoco. Nenhum status geral é traduzido em validação presumida.

Datas vêm exclusivamente de `official_at` dos eventos persistidos com estado correspondente, nunca de `observed_at`, prazos ou relógio local. Elas identificam registro oficial do estado, não uma data de transição garantida; criação original da solicitação não é persistida atualmente. Não há histórico logístico detalhado na Timeline Shopee.

## Pendências da integração

Para completar resultado solicitado, vídeos e datas originais, confirmar o contrato oficial e payload autorizado do endpoint já usado. Depois preservar campos comprovados na normalização existente e reutilizar a persistência, sem chamadas ao abrir tela. Não se alterou worker nesta tarefa; registros antigos continuam compatíveis e exibem ausência de dados explicitamente.

## Validação e entrega

Testes isolados exercitam renderização real dos componentes, leitura com banco em memória, mapeamento de estados ambíguos/finais, datas ausentes, posição da Timeline, ausência de tags de negrito, fotos, vídeos, preservação de campos e regressões ML. Typecheck e build local concluídos. Inspeção visual pelo navegador integrado ficou pendente: acesso à prévia local em 127.0.0.1 retornou timeout. Regras responsivas e estrutura foram verificadas automaticamente; não equivale a aprovação visual em navegador.

Depois do commit Smart Deploy, executar `npm run check:smart` e `npm run deploy:smart -- --dry-run`. Publicação permanece pendente de autorização explícita; só então `npm run deploy:smart -- --execute`. Classificação esperada da tarefa: Vercel sim; worker/VPS, migrations e dependências não. O plano cumulativo do Smart Deploy é a autoridade para publicação.
