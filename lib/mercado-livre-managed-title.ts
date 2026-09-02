export type MercadoLivreManagedTitleRecovery = {
  status: "pending" | "completed";
  requestedTitle: string;
  familyId?: string | null;
  familyName?: string | null;
  userProductId?: string | null;
  confirmedTitle?: string | null;
};

export function hasMercadoLivreFamily(link: Record<string, any>) {
  return Boolean(link.family_id || link.family_name || link.raw_data?.family_id || link.raw_data?.family_name);
}

export function pendingManagedTitleRecovery(
  requestedTitle: unknown,
  identifiers: { familyId?: unknown; familyName?: unknown; userProductId?: unknown } = {}
): MercadoLivreManagedTitleRecovery {
  const title = String(requestedTitle || "").trim();
  if (!title) throw new Error("Titulo solicitado ausente para atualizar family_name no Mercado Livre.");
  return {
    status: "pending",
    requestedTitle: title,
    familyId: optionalString(identifiers.familyId),
    familyName: optionalString(identifiers.familyName),
    userProductId: optionalString(identifiers.userProductId)
  };
}

export function prepareManagedTitleRetry(
  requestedData: Record<string, any>,
  identifiers: { familyId?: unknown; familyName?: unknown; userProductId?: unknown }
) {
  if (requestedData.managedTitleRecovery) return null;
  const copy = structuredClone(requestedData || {});
  const requestedTitle = copy.payload && typeof copy.payload === "object" ? copy.payload.title : undefined;
  if (!String(requestedTitle || "").trim()) return null;
  copy.managedTitleRecovery = pendingManagedTitleRecovery(requestedTitle, identifiers);
  delete copy.payload.title;
  return copy;
}

function optionalString(value: unknown) {
  const normalized = String(value || "").trim();
  return normalized || null;
}
