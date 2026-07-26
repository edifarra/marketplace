import { NextRequest, NextResponse } from "next/server";
import { hashPassword, requireMaster } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase-admin";

export async function GET() {
  if (!(await requireMaster())) return forbidden();
  const { data, error } = await supabaseAdmin()
    .from("app_users")
    .select("id,name,email,is_master,active,last_login_at,created_at,updated_at")
    .order("created_at");
  return error
    ? NextResponse.json({ error: "Falha ao listar usuarios." }, { status: 500 })
    : NextResponse.json({ users: data });
}

export async function POST(request: NextRequest) {
  if (!(await requireMaster())) return forbidden();
  const body = await request.json();
  const name = String(body.name || "").trim();
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8) {
    return NextResponse.json({ error: "Dados de usuario invalidos." }, { status: 400 });
  }
  const { data, error } = await supabaseAdmin().from("app_users").insert({
    name, email, password_hash: await hashPassword(password), is_master: false, active: body.active !== false
  }).select("id,name,email,is_master,active,created_at").single();
  if (error?.code === "23505") return NextResponse.json({ error: "Este e-mail ja esta em uso." }, { status: 409 });
  return error
    ? NextResponse.json({ error: "Falha ao criar usuario." }, { status: 500 })
    : NextResponse.json({ user: data }, { status: 201 });
}

function forbidden() {
  return NextResponse.json({ error: "Voce nao possui autorizacao para acessar este recurso." }, { status: 403 });
}
