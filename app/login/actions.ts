"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  AUTH_COOKIE_NAME,
  AUTH_SEEN_COOKIE_NAME,
  AuthUser,
  ensureInitialMaster,
  isAuthConfigured,
  setSessionCookie,
  verifyPassword
} from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase-admin";

type Attempt = { count: number; resetAt: number };
const attempts = new Map<string, Attempt>();

export async function loginAction(formData: FormData) {
  const next = sanitizeNext(String(formData.get("next") || "/"));
  const email = String(formData.get("email") || "").trim().toLowerCase();
  const password = String(formData.get("password") || "");
  const returnError = (message: string): never =>
    redirect(`/login?erro=${encodeURIComponent(message)}&next=${encodeURIComponent(next)}`);

  if (!isAuthConfigured()) {
    returnError("A autenticacao ainda nao foi configurada.");
  }

  const clientKey = headers().get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (isRateLimited(clientKey)) returnError("Muitas tentativas. Aguarde alguns minutos e tente novamente.");

  try {
    await ensureInitialMaster();
  } catch (error) {
    console.error("Falha ao preparar o usuario Master:", safeError(error));
    returnError("Nao foi possivel iniciar a autenticacao. Verifique a configuracao do ambiente.");
  }

  const { data } = await supabaseAdmin()
    .from("app_users")
    .select("id,name,email,password_hash,is_master,active,session_version")
    .eq("email", email)
    .maybeSingle();

  if (!data) {
    registerFailure(clientKey);
    returnError("E-mail ou senha invalidos.");
  }
  const user = data!;
  if (!(await verifyPassword(password, user.password_hash))) {
    registerFailure(clientKey);
    returnError("E-mail ou senha invalidos.");
  }
  if (!user.active) {
    registerFailure(clientKey);
    returnError("Este usuario esta inativo.");
  }

  attempts.delete(clientKey);
  await supabaseAdmin().from("app_users").update({ last_login_at: new Date().toISOString() }).eq("id", user.id);
  await setSessionCookie({
    id: user.id,
    name: user.name,
    email: user.email,
    isMaster: user.is_master,
    active: user.active,
    sessionVersion: Number(user.session_version)
  } satisfies AuthUser);
  redirect(next);
}

export async function logoutAction() {
  cookies().delete(AUTH_COOKIE_NAME);
  cookies().delete(AUTH_SEEN_COOKIE_NAME);
  redirect("/login");
}

function sanitizeNext(value: string) {
  return value.startsWith("/") && !value.startsWith("//") ? value : "/";
}

function isRateLimited(key: string) {
  const attempt = attempts.get(key);
  if (!attempt) return false;
  if (Date.now() >= attempt.resetAt) {
    attempts.delete(key);
    return false;
  }
  return attempt.count >= 5;
}

function registerFailure(key: string) {
  const existing = attempts.get(key);
  attempts.set(key, {
    count: (existing?.count || 0) + 1,
    resetAt: existing?.resetAt || Date.now() + 10 * 60 * 1000
  });
}

function safeError(error: unknown) {
  return error instanceof Error ? error.message : "erro desconhecido";
}
