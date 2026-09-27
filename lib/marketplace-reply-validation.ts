export type MarketplaceReplyContext = {
  marketplace?: string | null;
  conversation_type?: string | null;
};

export const OFFICIAL_MARKETPLACE_LINK_DOMAINS = {
  shopee: ["shopee.com.br"],
  mercado_livre: ["mercadolivre.com.br"]
} as const;

const LINK_PATTERN = /(?:https?:\/\/|www\.)[^\s<>"']+|\b(?:bit\.ly|tinyurl\.com|wa\.me)(?:\/[^\s<>"']*)?/giu;
const TRAILING_PUNCTUATION = /[),.;!?\]}]+$/u;

export function validateMarketplaceReply(text: string, conversation?: MarketplaceReplyContext) {
  const blocked: string[] = [];
  const warnings: string[] = [];
  if (!text) blocked.push("Digite uma resposta.");
  const maximum = conversation?.marketplace === "mercado_livre" && conversation?.conversation_type === "post_sale" ? 350 : 2000;
  if (text.length > maximum) blocked.push(`A resposta deve ter no máximo ${maximum.toLocaleString("pt-BR")} caracteres.`);
  if (/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/i.test(text)) blocked.push("Não informe ou solicite e-mails.");
  if (containsDisallowedLink(text, conversation?.marketplace)) blocked.push("Não informe links externos.");
  if (/(?:\+?55\s*)?(?:\(?\d{2}\)?\s*)?(?:9\s*)?\d{4}[-.\s]?\d{4}/.test(text) || /whats(?:app)?/i.test(text)) blocked.push("Não informe ou solicite telefone/WhatsApp.");
  if (/\b(?:pix|chave\s+pix|instagram|facebook|telegram)\b/i.test(text)) blocked.push("Não direcione o contato ou pagamento para fora do marketplace.");
  if (/\b(?:senha|pin|c[oó]digo\s+de\s+seguran[cç]a|cpf|cnpj)\b/i.test(text)) warnings.push("Revise a menção a dados pessoais ou de segurança.");
  if (/\b(?:reclama[cç][aã]o|endere[cç]o|pagamento\s+por\s+fora)\b/i.test(text)) warnings.push("Revise o conteúdo antes de enviar.");
  return { blocked, warnings };
}

export function containsDisallowedLink(text: string, marketplace?: string | null) {
  const allowedDomains = OFFICIAL_MARKETPLACE_LINK_DOMAINS[marketplace as keyof typeof OFFICIAL_MARKETPLACE_LINK_DOMAINS] || [];
  for (const match of text.matchAll(LINK_PATTERN)) {
    const candidate = match[0].replace(TRAILING_PUNCTUATION, "");
    try {
      const hostname = new URL(candidate.startsWith("www.") ? `https://${candidate}` : candidate).hostname.toLowerCase().replace(/\.$/, "");
      if (!allowedDomains.some(domain => hostname === domain || hostname.endsWith(`.${domain}`))) return true;
    } catch {
      return true;
    }
  }
  return false;
}
