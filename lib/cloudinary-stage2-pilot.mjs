export function mercadoLivreReadHeaders(link, accounts, now = Date.now()) {
  const account = accounts.find(item =>
    item.marketplace === "mercado_livre" &&
    String(item.id) === String(link.marketplace_account_id)
  );
  if (!account?.access_token) throw new Error("conta Mercado Livre não encontrada");
  if (account.token_expires_at && Date.parse(account.token_expires_at) <= now) {
    throw new Error("token Mercado Livre expirado; refresh proibido");
  }
  return { Authorization: `Bearer ${account.access_token}` };
}
