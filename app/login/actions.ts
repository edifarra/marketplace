"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AUTH_COOKIE_NAME, getExpectedAuthToken, isAuthConfigured } from "@/lib/auth";

export async function loginAction(formData: FormData) {
  const next = sanitizeNext(String(formData.get("next") || "/"));
  const password = String(formData.get("password") || "");

  if (!isAuthConfigured()) {
    redirect(`/login?erro=${encodeURIComponent("Configure SITE_PASSWORD no Vercel para ativar a protecao.")}`);
  }

  if (password !== process.env.SITE_PASSWORD && password !== process.env.APP_PASSWORD) {
    redirect(`/login?erro=${encodeURIComponent("Senha incorreta.")}&next=${encodeURIComponent(next)}`);
  }

  cookies().set(AUTH_COOKIE_NAME, await getExpectedAuthToken(), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30
  });

  redirect(next);
}

export async function logoutAction() {
  cookies().delete(AUTH_COOKIE_NAME);
  redirect("/login");
}

function sanitizeNext(value: string) {
  if (!value.startsWith("/") || value.startsWith("//")) {
    return "/";
  }

  return value;
}
