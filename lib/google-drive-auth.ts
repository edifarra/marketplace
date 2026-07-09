import { createSign } from "crypto";
import { readFile } from "fs/promises";
import { join } from "path";
import {
  getGoogleDriveOAuthAccessToken,
  getGoogleDriveOAuthAccountEmail,
  hasGoogleDriveOAuthConnection
} from "./google-drive-oauth";
import { supabaseAdmin } from "./supabase-admin";

type GoogleServiceAccount = {
  client_email?: string;
  private_key?: string;
  token_uri?: string;
};

type GoogleTokenResponse = {
  access_token?: string;
  expires_in?: number;
  token_type?: string;
  error?: string;
  error_description?: string;
};

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
const TOKEN_URI = "https://oauth2.googleapis.com/token";

let cachedToken: { accessToken: string; expiresAt: number; clientEmail: string } | null = null;

export async function hasGoogleDriveServerCredentials() {
  if (await hasGoogleDriveOAuthConnection()) {
    return true;
  }

  const account = await loadGoogleServiceAccount().catch(() => null);
  return Boolean(account?.client_email && account.private_key);
}

export async function getGoogleDriveAccessToken() {
  const oauthAccessToken = await getGoogleDriveOAuthAccessToken();
  if (oauthAccessToken) {
    return oauthAccessToken;
  }

  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt - 60_000 > now) {
    return cachedToken.accessToken;
  }

  const account = await getGoogleServiceAccount();
  const assertion = signServiceAccountJwt(account);
  const response = await fetch(account.token_uri || TOKEN_URI, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    })
  });

  const json = await response.json().catch(() => ({})) as GoogleTokenResponse;
  if (!response.ok || !json.access_token) {
    throw new Error(`Falha ao autenticar Google Drive via Service Account: ${JSON.stringify(json)}`);
  }

  cachedToken = {
    accessToken: json.access_token,
    expiresAt: now + (json.expires_in || 3600) * 1000,
    clientEmail: account.client_email
  };

  return cachedToken.accessToken;
}

export async function getGoogleDriveAccountEmail() {
  const oauthEmail = await getGoogleDriveOAuthAccountEmail();
  if (oauthEmail) {
    return oauthEmail;
  }

  if (cachedToken?.clientEmail) {
    return cachedToken.clientEmail;
  }

  const account = await getGoogleServiceAccount();
  return account.client_email;
}

async function getGoogleServiceAccount() {
  const account = await loadGoogleServiceAccount();
  if (!account.client_email || !account.private_key) {
    throw new Error("Configure GOOGLE_SERVICE_ACCOUNT_JSON com client_email e private_key da Service Account do Google Drive.");
  }

  return {
    client_email: account.client_email,
    private_key: account.private_key.replace(/\\n/g, "\n"),
    token_uri: account.token_uri || TOKEN_URI
  };
}

async function loadGoogleServiceAccount(): Promise<GoogleServiceAccount> {
  const savedJson = await loadSavedGoogleServiceAccountJson();
  if (savedJson) {
    return JSON.parse(savedJson) as GoogleServiceAccount;
  }

  const rawJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  if (rawJson) {
    return JSON.parse(rawJson) as GoogleServiceAccount;
  }

  const filePath = process.env.GOOGLE_SERVICE_ACCOUNT_FILE?.trim() || join(process.cwd(), "service-account.json");
  const file = await readFile(filePath, "utf8");
  return JSON.parse(file) as GoogleServiceAccount;
}

async function loadSavedGoogleServiceAccountJson() {
  const supabase = supabaseAdmin();
  const { data } = await supabase
    .from("settings")
    .select("value")
    .eq("key", "GOOGLE_SERVICE_ACCOUNT_JSON")
    .maybeSingle()
    .throwOnError();

  return settingToString(data?.value).trim();
}

function signServiceAccountJwt(account: Required<Pick<GoogleServiceAccount, "client_email" | "private_key" | "token_uri">>) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({
    iss: account.client_email,
    scope: DRIVE_SCOPE,
    aud: account.token_uri,
    exp: now + 3600,
    iat: now
  }));
  const input = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256").update(input).sign(account.private_key);
  return `${input}.${base64Url(signature)}`;
}

function base64Url(value: string | Buffer) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
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
