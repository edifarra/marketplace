import "server-only";

import { cookies } from "next/headers";
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "crypto";
import { promisify } from "util";
import { supabaseAdmin } from "@/lib/supabase-admin";
import {
  AUTH_COOKIE_NAME,
  AUTH_SEEN_COOKIE_NAME,
  SessionPayload,
  createSessionToken,
  getSessionMaxAgeSeconds,
  verifySessionToken
} from "@/lib/auth-session";

const scrypt = promisify(scryptCallback);

export { AUTH_COOKIE_NAME, AUTH_SEEN_COOKIE_NAME, getSessionMaxAgeSeconds };

export type AuthUser = {
  id: string;
  name: string;
  email: string;
  isMaster: boolean;
  active: boolean;
  sessionVersion: number;
};

export function isAuthConfigured() {
  return getMissingAuthConfiguration().length === 0;
}

export function getMissingAuthConfiguration() {
  const missing: string[] = [];
  if (!process.env.AUTH_SESSION_SECRET) missing.push("AUTH_SESSION_SECRET");
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) missing.push("NEXT_PUBLIC_SUPABASE_URL");
  if (!(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)) {
    missing.push("SUPABASE_SERVICE_ROLE_KEY");
  }
  return missing;
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string) {
  const [algorithm, saltValue, hashValue] = stored.split("$");
  if (algorithm !== "scrypt" || !saltValue || !hashValue) return false;
  const expected = Buffer.from(hashValue, "base64url");
  const actual = (await scrypt(password, Buffer.from(saltValue, "base64url"), expected.length)) as Buffer;
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function ensureInitialMaster() {
  const supabase = supabaseAdmin();
  const email = "edifarra@gmail.com";
  const { data: existing, error } = await supabase
    .from("app_users")
    .select("id")
    .eq("email", email)
    .maybeSingle();

  if (error) throw error;
  if (existing) return;

  const initialPassword = process.env.MASTER_INITIAL_PASSWORD;
  if (!initialPassword) {
    throw new Error("Configure MASTER_INITIAL_PASSWORD para criar o usuario Master inicial.");
  }
  if (initialPassword.length < 8) {
    throw new Error("MASTER_INITIAL_PASSWORD deve ter no minimo 8 caracteres.");
  }

  const { error: insertError } = await supabase.from("app_users").insert({
    name: "Ed",
    email,
    password_hash: await hashPassword(initialPassword),
    is_master: true,
    active: true
  });
  if (insertError && insertError.code !== "23505") throw insertError;
}

export async function getCurrentUser(): Promise<AuthUser | null> {
  const token = cookies().get(AUTH_COOKIE_NAME)?.value;
  const payload = await verifySessionToken(token);
  if (!payload) return null;
  return loadSessionUser(payload);
}

export async function requireMaster() {
  const user = await getCurrentUser();
  if (!user?.isMaster) return null;
  return user;
}

export async function loadSessionUser(payload: SessionPayload): Promise<AuthUser | null> {
  const { data, error } = await supabaseAdmin()
    .from("app_users")
    .select("id,name,email,is_master,active,session_version")
    .eq("id", payload.sub)
    .maybeSingle();
  if (error || !data || !data.active || Number(data.session_version) !== payload.sessionVersion) return null;
  return {
    id: data.id,
    name: data.name,
    email: data.email,
    isMaster: data.is_master,
    active: data.active,
    sessionVersion: Number(data.session_version)
  };
}

export async function setSessionCookie(user: AuthUser) {
  const token = await createSessionToken({
    sub: user.id,
    name: user.name,
    isMaster: user.isMaster,
    sessionVersion: user.sessionVersion
  });
  cookies().set(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: getSessionMaxAgeSeconds()
  });
  cookies().set(AUTH_SEEN_COOKIE_NAME, "1", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: getSessionMaxAgeSeconds() + 24 * 60 * 60
  });
}
