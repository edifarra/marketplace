import { revalidatePath } from "next/cache";
import { supabaseAdmin } from "./supabase-admin";

export type GoogleOAuthToken = {
  access_token: string;
  refresh_token: string;
  expires_at: string;
  scope: string;
  token_type: string;
  google_account_email?: string;
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

const GOOGLE_OAUTH_SCOPE = "https://www.googleapis.com/auth/drive";
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_API = "https://www.googleapis.com/drive/v3";

export function buildGoogleOAuthUrl(state: string) {
  const config = getGoogleOAuthConfig();
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: GOOGLE_OAUTH_SCOPE,
    access_type: "offline",
    prompt: "consent",
    state
  });

  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export async function exchangeGoogleOAuthCode(code: string): Promise<GoogleOAuthToken> {
  const config = getGoogleOAuthConfig();
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
    throw new Error(`Falha no OAuth Google: ${JSON.stringify(json)}`);
  }

  const currentToken = await getGoogleOAuthToken();
  const token: GoogleOAuthToken = {
    access_token: json.access_token,
    refresh_token: json.refresh_token || currentToken?.refresh_token || "",
    expires_at: expiresAt(json.expires_in),
    scope: json.scope || GOOGLE_OAUTH_SCOPE,
    token_type: json.token_type || "Bearer"
  };
  token.google_account_email = await fetchGoogleDriveAccountEmail(token.access_token);
  await saveGoogleOAuthToken(token);
  return token;
}

export async function getGoogleDriveAccessToken() {
  const token = await getGoogleOAuthToken();
  if (!token?.access_token) {
    throw new Error("Google Drive nao conectado. Clique em Conectar Google Drive.");
  }

  if (!shouldRefresh(token.expires_at)) {
    return token.access_token;
  }

  if (!token.refresh_token) {
    throw new Error("Google Drive sem refresh_token. Clique em Conectar Google Drive novamente.");
  }

  const refreshed = await refreshGoogleAccessToken(token);
  return refreshed.access_token;
}

export async function getGoogleDriveAccountEmail() {
  const token = await getGoogleOAuthToken();
  return token?.google_account_email || "Conta Google conectada";
}

export async function getGoogleOAuthToken(): Promise<GoogleOAuthToken | null> {
  const supabase = supabaseAdmin();
  const { data } = await supabase
    .from("settings")
    .select("key,value")
    .in("key", [
      "GOOGLE_OAUTH_ACCESS_TOKEN",
      "GOOGLE_OAUTH_REFRESH_TOKEN",
      "GOOGLE_OAUTH_EXPIRES_AT",
      "GOOGLE_OAUTH_SCOPE",
      "GOOGLE_OAUTH_TOKEN_TYPE",
      "GOOGLE_OAUTH_ACCOUNT_EMAIL"
    ])
    .throwOnError();

  const settings = new Map((data ?? []).map((row) => [row.key, settingToString(row.value)]));
  const accessToken = settings.get("GOOGLE_OAUTH_ACCESS_TOKEN") || "";
  if (!accessToken) {
    return null;
  }

  return {
    access_token: accessToken,
    refresh_token: settings.get("GOOGLE_OAUTH_REFRESH_TOKEN") || "",
    expires_at: settings.get("GOOGLE_OAUTH_EXPIRES_AT") || "",
    scope: settings.get("GOOGLE_OAUTH_SCOPE") || GOOGLE_OAUTH_SCOPE,
    token_type: settings.get("GOOGLE_OAUTH_TOKEN_TYPE") || "Bearer",
    google_account_email: settings.get("GOOGLE_OAUTH_ACCOUNT_EMAIL") || ""
  };
}

async function refreshGoogleAccessToken(current: GoogleOAuthToken): Promise<GoogleOAuthToken> {
  const config = getGoogleOAuthConfig();
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
    throw new Error(`Falha ao renovar token Google Drive: ${JSON.stringify(json)}`);
  }

  const refreshed: GoogleOAuthToken = {
    access_token: json.access_token,
    refresh_token: current.refresh_token,
    expires_at: expiresAt(json.expires_in),
    scope: json.scope || current.scope,
    token_type: json.token_type || current.token_type,
    google_account_email: current.google_account_email || await fetchGoogleDriveAccountEmail(json.access_token)
  };
  await saveGoogleOAuthToken(refreshed);
  return refreshed;
}

async function saveGoogleOAuthToken(token: GoogleOAuthToken) {
  const supabase = supabaseAdmin();
  await supabase.from("settings").upsert([
    {
      key: "GOOGLE_OAUTH_ACCESS_TOKEN",
      value: token.access_token,
      description: "[GOOGLE_DRIVE] OAuth access_token"
    },
    {
      key: "GOOGLE_OAUTH_REFRESH_TOKEN",
      value: token.refresh_token,
      description: "[GOOGLE_DRIVE] OAuth refresh_token"
    },
    {
      key: "GOOGLE_OAUTH_EXPIRES_AT",
      value: token.expires_at,
      description: "[GOOGLE_DRIVE] OAuth expires_at"
    },
    {
      key: "GOOGLE_OAUTH_SCOPE",
      value: token.scope,
      description: "[GOOGLE_DRIVE] OAuth scope"
    },
    {
      key: "GOOGLE_OAUTH_TOKEN_TYPE",
      value: token.token_type,
      description: "[GOOGLE_DRIVE] OAuth token_type"
    },
    {
      key: "GOOGLE_OAUTH_ACCOUNT_EMAIL",
      value: token.google_account_email || "",
      description: "[GOOGLE_DRIVE] OAuth google_account_email"
    }
  ]).throwOnError();

  revalidatePath("/");
  revalidatePath("/configuracoes/google-drive");
}

async function fetchGoogleDriveAccountEmail(accessToken: string) {
  const params = new URLSearchParams({
    fields: "user(emailAddress)"
  });
  const response = await fetch(`${DRIVE_API}/about?${params.toString()}`, {
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

function getGoogleOAuthConfig() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID || "";
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET || "";
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI || "http://localhost:3000/api/google/oauth/callback";

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("Configure GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET e GOOGLE_OAUTH_REDIRECT_URI.");
  }

  return { clientId, clientSecret, redirectUri };
}

function shouldRefresh(expiresAtValue: string) {
  if (!expiresAtValue) {
    return true;
  }

  return Date.now() >= new Date(expiresAtValue).getTime() - 60_000;
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
