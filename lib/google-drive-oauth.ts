import { revalidatePath } from "next/cache";
import { getPublicAppUrl } from "./app-url";
import { supabaseAdmin } from "./supabase-admin";

export type GoogleDriveOAuthToken = {
  access_token: string;
  refresh_token: string;
  expires_at: string;
  scope: string;
  token_type: string;
  google_account_email: string;
};

type GoogleTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
};

const GOOGLE_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_API = "https://www.googleapis.com/drive/v3";

export function buildGoogleDriveConnectUrl(state: string, email: string) {
  const config = getGoogleDriveOAuthConfig();
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: GOOGLE_DRIVE_SCOPE,
    access_type: "offline",
    prompt: "consent",
    state
  });

  if (email) {
    params.set("login_hint", email);
  }

  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export async function exchangeGoogleDriveCode(code: string, requestedEmail: string) {
  const config = getGoogleDriveOAuthConfig();
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: "authorization_code"
    })
  });
  const json = await response.json().catch(() => ({})) as GoogleTokenResponse;
  if (!response.ok || !json.access_token) {
    throw new Error(`Google nao concluiu a conexao: ${JSON.stringify(json)}`);
  }

  const accountEmail = await fetchGoogleDriveAccountEmail(json.access_token);
  const token: GoogleDriveOAuthToken = {
    access_token: json.access_token,
    refresh_token: json.refresh_token || "",
    expires_at: expiresAt(json.expires_in),
    scope: json.scope || GOOGLE_DRIVE_SCOPE,
    token_type: json.token_type || "Bearer",
    google_account_email: accountEmail || requestedEmail
  };

  if (!token.refresh_token) {
    const current = await getGoogleDriveOAuthToken();
    token.refresh_token = current?.refresh_token || "";
  }

  if (!token.refresh_token) {
    throw new Error("Google nao retornou autorizacao permanente. Tente conectar novamente e confirme o acesso offline.");
  }

  await saveGoogleDriveOAuthToken(token);
  return token;
}

export async function getGoogleDriveOAuthAccessToken() {
  const token = await getGoogleDriveOAuthToken();
  if (!token?.access_token) {
    return "";
  }

  if (!shouldRefresh(token.expires_at)) {
    return token.access_token;
  }

  if (!token.refresh_token) {
    throw new Error("Conta Google Drive precisa ser conectada novamente para renovar o acesso.");
  }

  const refreshed = await refreshGoogleDriveAccessToken(token);
  return refreshed.access_token;
}

export async function getGoogleDriveOAuthAccountEmail() {
  const token = await getGoogleDriveOAuthToken();
  return token?.google_account_email || "";
}

export async function hasGoogleDriveOAuthConnection() {
  const token = await getGoogleDriveOAuthToken();
  return Boolean(token?.access_token && token.refresh_token);
}

async function getGoogleDriveOAuthToken(): Promise<GoogleDriveOAuthToken | null> {
  const supabase = supabaseAdmin();
  const { data } = await supabase
    .from("settings")
    .select("key,value")
    .in("key", [
      "GOOGLE_DRIVE_ACCESS_TOKEN",
      "GOOGLE_DRIVE_REFRESH_TOKEN",
      "GOOGLE_DRIVE_EXPIRES_AT",
      "GOOGLE_DRIVE_SCOPE",
      "GOOGLE_DRIVE_TOKEN_TYPE",
      "GOOGLE_DRIVE_ACCOUNT_EMAIL"
    ])
    .throwOnError();

  const settings = new Map((data ?? []).map((row) => [row.key, settingToString(row.value)]));
  const accessToken = settings.get("GOOGLE_DRIVE_ACCESS_TOKEN") || "";
  if (!accessToken) {
    return null;
  }

  return {
    access_token: accessToken,
    refresh_token: settings.get("GOOGLE_DRIVE_REFRESH_TOKEN") || "",
    expires_at: settings.get("GOOGLE_DRIVE_EXPIRES_AT") || "",
    scope: settings.get("GOOGLE_DRIVE_SCOPE") || GOOGLE_DRIVE_SCOPE,
    token_type: settings.get("GOOGLE_DRIVE_TOKEN_TYPE") || "Bearer",
    google_account_email: settings.get("GOOGLE_DRIVE_ACCOUNT_EMAIL") || ""
  };
}

async function refreshGoogleDriveAccessToken(current: GoogleDriveOAuthToken) {
  const config = getGoogleDriveOAuthConfig();
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: current.refresh_token,
      grant_type: "refresh_token"
    })
  });
  const json = await response.json().catch(() => ({})) as GoogleTokenResponse;
  if (!response.ok || !json.access_token) {
    throw new Error(`Falha ao renovar automaticamente a conexao Google Drive: ${JSON.stringify(json)}`);
  }

  const refreshed: GoogleDriveOAuthToken = {
    access_token: json.access_token,
    refresh_token: current.refresh_token,
    expires_at: expiresAt(json.expires_in),
    scope: json.scope || current.scope,
    token_type: json.token_type || current.token_type,
    google_account_email: current.google_account_email || await fetchGoogleDriveAccountEmail(json.access_token)
  };
  await saveGoogleDriveOAuthToken(refreshed);
  return refreshed;
}

async function saveGoogleDriveOAuthToken(token: GoogleDriveOAuthToken) {
  const supabase = supabaseAdmin();
  await supabase.from("settings").upsert([
    {
      key: "GOOGLE_DRIVE_ACCESS_TOKEN",
      value: token.access_token,
      description: "[GOOGLE_DRIVE] access_token da conta conectada"
    },
    {
      key: "GOOGLE_DRIVE_REFRESH_TOKEN",
      value: token.refresh_token,
      description: "[GOOGLE_DRIVE] refresh_token da conta conectada"
    },
    {
      key: "GOOGLE_DRIVE_EXPIRES_AT",
      value: token.expires_at,
      description: "[GOOGLE_DRIVE] validade do access_token"
    },
    {
      key: "GOOGLE_DRIVE_SCOPE",
      value: token.scope,
      description: "[GOOGLE_DRIVE] escopo autorizado"
    },
    {
      key: "GOOGLE_DRIVE_TOKEN_TYPE",
      value: token.token_type,
      description: "[GOOGLE_DRIVE] tipo do token"
    },
    {
      key: "GOOGLE_DRIVE_ACCOUNT_EMAIL",
      value: token.google_account_email,
      description: "[GOOGLE_DRIVE] e-mail da conta conectada"
    }
  ]).throwOnError();

  revalidatePath("/");
  revalidatePath("/configuracoes/google-drive");
}

async function fetchGoogleDriveAccountEmail(accessToken: string) {
  const response = await fetch(`${DRIVE_API}/about?fields=user(emailAddress)`, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json"
    }
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    return "";
  }

  return typeof json === "object" && json && "user" in json
    ? String((json as { user?: { emailAddress?: string } }).user?.emailAddress || "")
    : "";
}

function getGoogleDriveOAuthConfig() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID || "";
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET || "";
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI || `${getPublicAppUrl()}/api/google/oauth/callback`;

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("A conexao com o Google ainda nao esta configurada no servidor.");
  }

  return { clientId, clientSecret, redirectUri };
}

function shouldRefresh(expiresAtValue: string) {
  if (!expiresAtValue) {
    return true;
  }

  return Date.now() >= new Date(expiresAtValue).getTime() - 5 * 60_000;
}

function expiresAt(expiresIn = 3600) {
  return new Date(Date.now() + expiresIn * 1000).toISOString();
}

function settingToString(value: unknown) {
  if (typeof value === "string") {
    return value;
  }

  if (value === null || value === undefined) {
    return "";
  }

  return JSON.stringify(value);
}
