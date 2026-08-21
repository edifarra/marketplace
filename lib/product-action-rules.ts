export type ProductActionMode = "TINY" | "MARKETPLACE_DIRETO";

type ProductLinks = {
  tinyProductId?: string | null;
  marketplaceLinks: Array<{ accountId?: string | null; externalId?: string | null }>;
};

export function getProductActionState(mode: ProductActionMode, activeAccountIds: string[], links: ProductLinks) {
  if (mode === "TINY") {
    const linked = Boolean(links.tinyProductId);
    return { showSave: linked, showSend: !linked, saveBeforeSend: true };
  }

  const linkedAccountIds = new Set(links.marketplaceLinks
    .filter(link => link.externalId && link.accountId)
    .map(link => String(link.accountId)));
  const hasLink = linkedAccountIds.size > 0;
  const hasMissingAccount = activeAccountIds.some(accountId => !linkedAccountIds.has(accountId));
  return { showSave: hasLink, showSend: hasMissingAccount, saveBeforeSend: true };
}
