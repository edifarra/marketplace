"use client";

import type { DeflatorRange, PriceEvaluation } from "@/lib/price-evaluation";

export function PriceEvaluationDetails({ initial: evaluation }: { initial: PriceEvaluation }) {
  const minimum = evaluation.settings.VALOR_MINIMO ?? evaluation.settings["VALOR_MÍNIMO"] ?? 20;
  const definition = normalize(String(evaluation.settings.DEFINICAO_PRECO || "MENOR")).toUpperCase();
  return <>
    <section className="card section"><div className="price-detail-grid">
      <Info label="Definição do preço" value={evaluation.settings.DEFINICAO_PRECO} />
      <Info label="Anúncios para cálculo" value={evaluation.settings.QUANTIDADE_ANUNCIOS_PARA_CALCULO} />
      <Info label="Anúncios a recuperar" value={evaluation.settings.QUANTIDADE_ANUNCIOS_RECUPERADOS} />
      <Info label="Valor do deflator aplicado" value={formatDeflator(evaluation.effectiveDeflator, evaluation.appliedRange?.deflator)} />
      <Info label="Valores em gap" value={evaluation.settings.VALORES_EM_GAP} />
      <Info label="Status do cálculo" value={statusLabel(evaluation.status)} />
      <Info label="Total de ofertas localizadas" value={evaluation.listings.length} />
      <Info label="Tipo de placa" value={evaluation.typeName} /><Info label="Marca" value={evaluation.brandName} />
      <Info label="Modelo" value={evaluation.product.model} /><Info label="Código da placa" value={evaluation.product.board_code} />
      <Info label="Versão" value={evaluation.product.version} /><Info label="Menor preço permitido" value={currency(Number(minimum))} />
      <Info label="Outlier inferior" value={percent(evaluation.settings.PERCENTUAL_OUTLIER_INFERIOR)} />
      <Info label="Busca utilizada no Mercado Livre" value={evaluation.searchString} wide />
      <LinkInfo label="Endereço utilizado na busca" href={evaluation.searchUrl} />
      {evaluation.searchSource === "CATALOGO" && <LinkInfo label="Consulta online" href={evaluation.catalogUrl} />}
      <Info label="Origem dos anúncios" value={evaluation.searchSource === "CACHE" ? "Dados armazenados (até 3 dias)" : "API oficial do Mercado Livre"} wide />
      <Info label="Pesquisa realizada em" value={new Date(evaluation.searchedAt).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })} />
      <Info label="Faixa do deflator aplicada" value={formatAppliedRange(evaluation.appliedRange)} wide />
    </div></section>
    {evaluation.error && <div className="form-error section">A identificação do produto foi concluída, mas os anúncios não puderam ser consultados: {evaluation.error}</div>}
    <section className="grid price-metrics section">
      <Metric label="Menor valor" value={currency(evaluation.lowest)} considered={definition === "MENOR"} />
      <Metric label="Segundo valor" value={currency(evaluation.secondLowest)} considered={definition === "SEGUNDO"} />
      <Metric label="Preço médio" value={currency(evaluation.average)} considered={definition === "MEDIA"} />
      <Metric label="Maior valor" value={currency(evaluation.highest)} considered={definition === "MAIOR"} />
      <div className="card suggested-price"><div className="metric-label">Preço final sugerido</div><div className="metric-value">{currency(evaluation.suggested)}</div>{evaluation.basedOnMinimum && <small>Baseado no valor mínimo</small>}</div>
    </section>
    <section className="section card"><div className="table-toolbar"><div><h2>Anúncios localizados</h2><div className="muted">{evaluation.listings.length} anúncio(s), respeitando o limite configurado no motor de preço.</div></div></div>
      <div className="table-wrap"><table className="price-listings"><thead><tr><th>Anúncio</th><th>Preço</th><th>Termos da busca</th><th>Cód. placa encontrado</th><th>Versão encontrada</th><th>Outlier inferior</th><th>Considerado</th><th>Válido</th><th>Motivo da invalidação</th></tr></thead><tbody>
        {evaluation.listings.length === 0 ? <tr><td colSpan={9} className="muted">Nenhum anúncio localizado.</td></tr> : evaluation.listings.map((item) => <tr key={item.id}><td><a className="external-product-link" href={item.link} target="_blank" rel="noreferrer">{item.title}</a></td><td>{currency(item.price)}</td><td><Badge yes={item.searchTermsFound} /></td><td><MatchBadge found={item.boardCodeFound} /></td><td><MatchBadge found={item.versionFound} /></td><td><Badge yes={item.inRange} /></td><td><Badge yes={item.considered} /></td><td><Badge yes={item.valid} /></td><td>{item.rejectionReasons.join("; ") || "-"}</td></tr>)}
      </tbody></table></div>
    </section>
  </>;
}

function Info({ label, value, wide = false }: { label: string; value: unknown; wide?: boolean }) { return <div className={`price-info${wide ? " wide" : ""}`}><span>{label}</span><strong>{value == null || value === "" ? "-" : String(value)}</strong></div>; }
function LinkInfo({ label, href }: { label: string; href: string }) { return <div className="price-info wide"><span>{label}</span><strong><a className="external-product-link" href={href} target="_blank" rel="noreferrer">{href}</a></strong></div>; }
function Metric({ label, value, considered }: { label: string; value: string; considered?: boolean }) { return <div className={`card price-metric${considered ? " considered" : ""}`}>{considered && <div className="considered-label">Valor considerado</div>}<div className="metric-label">{label}</div><div className="metric-value">{value}</div></div>; }
function Badge({ yes }: { yes: boolean }) { return <span className={`price-badge ${yes ? "yes" : "no"}`}>{yes ? "Sim" : "Não"}</span>; }
function MatchBadge({ found }: { found: boolean | null }) { return found === null ? <>-</> : <span className={`price-match ${found ? "yes" : "no"}`} title={found ? "Encontrado" : "Não encontrado"}>{found ? "✓" : "✕"}</span>; }
function currency(value: number | null) { return value == null || !Number.isFinite(value) ? "-" : value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }); }
function percent(value: unknown) { const raw = String(value ?? "").trim(); const number = Number(raw.replace("%", "").replace(",", ".")); return Number.isFinite(number) ? `${(raw.includes("%") || number > 1 ? number : number * 100).toLocaleString("pt-BR")}%` : "-"; }
function formatDeflator(value: number, type?: string) { return type === "porcentagem" ? `${value.toLocaleString("pt-BR")}%` : currency(value); }
function formatAppliedRange(range: DeflatorRange | null) { return range ? `Com valor considerado entre ${currency(range.min)} e ${currency(range.max)}. Arredondamento na casa dos 5: ${range.arred ? "Ativo" : "Inativo"}. Deflator: ${formatDeflator(range.value, range.deflator)}.` : "Nenhuma faixa ativa corresponde ao valor considerado."; }
function statusLabel(status: PriceEvaluation["status"]) { return status === "VERIFICACAO_MANUAL" ? "Definir Preço Manual" : status === "PRECO_MINIMO" ? "Preço mínimo" : "Calculado"; }
function normalize(value: string) { return value.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); }
