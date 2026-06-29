export const AUTH_COOKIE_NAME = "estoque_session";

export function isAuthConfigured() {
  return Boolean(getSitePassword());
}

export async function getExpectedAuthToken() {
  const password = getSitePassword();
  if (!password) {
    return "";
  }

  return sha256(`${password}:${getSessionSecret()}`);
}

export async function isValidAuthToken(token?: string | null) {
  if (!isAuthConfigured()) {
    return true;
  }

  return Boolean(token) && token === await getExpectedAuthToken();
}

function getSitePassword() {
  return process.env.SITE_PASSWORD || process.env.APP_PASSWORD || "";
}

function getSessionSecret() {
  return process.env.SITE_SESSION_SECRET || process.env.NEXTAUTH_SECRET || "estoque-default-session";
}

async function sha256(value: string) {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
