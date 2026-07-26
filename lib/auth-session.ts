export const AUTH_COOKIE_NAME = "gestao_marketplace_session";
export const AUTH_SEEN_COOKIE_NAME = "gestao_marketplace_session_seen";

export type SessionPayload = {
  sub: string;
  name: string;
  isMaster: boolean;
  sessionVersion: number;
  exp: number;
};

export function getSessionMaxAgeSeconds() {
  const configured = Number(process.env.SESSION_MAX_AGE_MINUTES || "60");
  const minutes = Number.isFinite(configured) && configured > 0 ? configured : 60;
  return Math.floor(minutes * 60);
}

export async function createSessionToken(
  user: Omit<SessionPayload, "exp">
): Promise<string> {
  const payload: SessionPayload = {
    ...user,
    exp: Math.floor(Date.now() / 1000) + getSessionMaxAgeSeconds()
  };
  const encoded = encodeBase64Url(JSON.stringify(payload));
  return `${encoded}.${await sign(encoded)}`;
}

export async function verifySessionToken(token?: string | null): Promise<SessionPayload | null> {
  if (!token || !process.env.AUTH_SESSION_SECRET) return null;
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature || !(await safeEqual(signature, await sign(encoded)))) return null;
  try {
    const payload = JSON.parse(decodeBase64Url(encoded)) as SessionPayload;
    if (!payload.sub || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

async function sign(value: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(process.env.AUTH_SESSION_SECRET || ""),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const result = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(result));
}

async function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

function encodeBase64Url(value: string) {
  return bytesToBase64Url(new TextEncoder().encode(value));
}

function decodeBase64Url(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized);
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
