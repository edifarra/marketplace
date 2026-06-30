export function getPublicAppUrl() {
  const explicitUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (explicitUrl) {
    return stripTrailingSlash(explicitUrl);
  }

  const vercelUrl = process.env.VERCEL_URL;
  if (vercelUrl) {
    return stripTrailingSlash(vercelUrl.startsWith("http") ? vercelUrl : `https://${vercelUrl}`);
  }

  return "";
}

export function getMercadoLivreRedirectUri(configuredRedirectUri?: string | null) {
  const redirectUri = configuredRedirectUri?.trim()
    || `${getPublicAppUrl()}/api/mercado-livre/oauth/callback`;

  if (!redirectUri || !redirectUri.startsWith("https://")) {
    throw new Error(
      "Redirect URI do Mercado Livre precisa ser HTTPS. Configure NEXT_PUBLIC_APP_URL com sua URL da Vercel ou preencha Redirect URI em Configuracoes > MarketPlace."
    );
  }

  return redirectUri;
}

export function getShopeeRedirectUri(configuredRedirectUri?: string | null) {
  const redirectUri = configuredRedirectUri?.trim()
    || process.env.SHOPEE_REDIRECT_URI
    || `${getPublicAppUrl()}/api/shopee/oauth/callback`;

  if (!redirectUri || !redirectUri.startsWith("https://")) {
    throw new Error(
      "Redirect URI da Shopee precisa ser HTTPS. Configure SHOPEE_REDIRECT_URI ou NEXT_PUBLIC_APP_URL com sua URL publica HTTPS."
    );
  }

  return redirectUri;
}

function stripTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}
