import { NextRequest, NextResponse } from "next/server";
import {
  AUTH_COOKIE_NAME,
  AUTH_SEEN_COOKIE_NAME,
  createSessionToken,
  getSessionMaxAgeSeconds,
  SessionPayload,
  verifySessionToken
} from "@/lib/auth-session";

const PUBLIC_PATHS = ["/login", "/acesso-negado"];

// Integrações servidor-a-servidor mantêm sua autenticação técnica própria.
const TECHNICAL_API_PATHS = [
  "/api/webhooks",
  "/api/marketplace-queue/process",
  "/api/telegram/dispatch-check",
  "/api/estoque/sync/worker",
  "/api/prices/process",
  "/api/prices/evaluate",
  "/api/mercado-livre/oauth/callback",
  "/api/shopee/oauth/callback",
  "/api/google/oauth/callback",
  "/api/pipeline/products",
  "/api/pipeline/run"
];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname === "/api/pipeline/run") {
    const payload = await verifySessionToken(request.cookies.get(AUTH_COOKIE_NAME)?.value);
    const user = payload ? await loadActiveUser(payload) : null;
    if (user) {
      const headers = new Headers(request.headers);
      headers.set("x-dashboard-authenticated", "1");
      return NextResponse.next({ request: { headers } });
    }
    // Sem sessao, a propria rota exige CRON_SECRET e continua apta ao Vercel Cron/VPS.
    return NextResponse.next();
  }
  if (isUnder(pathname, PUBLIC_PATHS) || isUnder(pathname, TECHNICAL_API_PATHS)) {
    return NextResponse.next();
  }

  if (!isConfigured()) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { error: "Autenticacao indisponivel por configuracao incompleta." },
        { status: 503 }
      );
    }
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("configuracao", "incompleta");
    return NextResponse.redirect(loginUrl);
  }

  const payload = await verifySessionToken(request.cookies.get(AUTH_COOKIE_NAME)?.value);
  const user = payload ? await loadActiveUser(payload) : null;
  if (!user) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Acesso nao autorizado." }, { status: 401 });
    }
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", `${pathname}${request.nextUrl.search}`);
    if (request.cookies.has(AUTH_COOKIE_NAME) || request.cookies.has(AUTH_SEEN_COOKIE_NAME)) {
      loginUrl.searchParams.set("sessao", "expirada");
    }
    const response = NextResponse.redirect(loginUrl);
    response.cookies.delete(AUTH_COOKIE_NAME);
    return response;
  }

  if (isUnder(pathname, ["/configuracoes/usuarios", "/configuracoes/notificacoes-telegram", "/api/users", "/api/telegram/test"]) && !user.isMaster) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Voce nao possui autorizacao para acessar este recurso." }, { status: 403 });
    }
    return NextResponse.rewrite(new URL("/acesso-negado", request.url), { status: 403 });
  }

  const response = NextResponse.next();
  response.cookies.set(AUTH_COOKIE_NAME, await createSessionToken(user), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: getSessionMaxAgeSeconds()
  });
  response.cookies.set(AUTH_SEEN_COOKIE_NAME, "1", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: getSessionMaxAgeSeconds() + 24 * 60 * 60
  });
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"]
};

function isConfigured() {
  return Boolean(
    process.env.AUTH_SESSION_SECRET &&
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
    (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
  );
}

function isUnder(pathname: string, paths: string[]) {
  return paths.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

async function loadActiveUser(payload: SessionPayload) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  const response = await fetch(
    `${url}/rest/v1/app_users?id=eq.${encodeURIComponent(payload.sub)}&select=id,name,is_master,active,session_version`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` }, cache: "no-store" }
  );
  if (!response.ok) return null;
  const [row] = await response.json();
  if (!row?.active || Number(row.session_version) !== payload.sessionVersion) return null;
  return {
    sub: row.id as string,
    name: row.name as string,
    isMaster: Boolean(row.is_master),
    sessionVersion: Number(row.session_version)
  };
}
