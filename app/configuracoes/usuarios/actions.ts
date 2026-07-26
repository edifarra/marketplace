"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { hashPassword, requireMaster } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase-admin";

export async function createUserAction(formData: FormData) {
  if (!(await requireMaster())) redirect("/acesso-negado");
  const values = parseUserForm(formData, true);
  if (values.error) return redirectWith("erro", values.error);

  const { error } = await supabaseAdmin().from("app_users").insert({
    name: values.name,
    email: values.email,
    password_hash: await hashPassword(values.password!),
    is_master: false,
    active: values.active
  });
  if (error?.code === "23505") return redirectWith("erro", "Este e-mail ja esta em uso.");
  if (error) return redirectWith("erro", "Nao foi possivel criar o usuario.");
  revalidatePath("/configuracoes/usuarios");
  redirectWith("sucesso", "Usuario criado com sucesso.");
}

export async function updateUserAction(formData: FormData) {
  if (!(await requireMaster())) redirect("/acesso-negado");
  const id = String(formData.get("id") || "");
  const values = parseUserForm(formData, false);
  if (!id || values.error) return redirectWith("erro", values.error || "Usuario invalido.");

  const supabase = supabaseAdmin();
  const { data: target } = await supabase.from("app_users").select("is_master").eq("id", id).maybeSingle();
  const active = target?.is_master ? true : values.active;
  const { error } = await supabase
    .from("app_users")
    .update({
      name: values.name,
      email: values.email,
      active,
      ...(values.active ? {} : { session_version: await nextSessionVersion(id) })
    })
    .eq("id", id);
  if (error?.code === "23505") return redirectWith("erro", "Este e-mail ja esta em uso.");
  if (error) return redirectWith("erro", "Nao foi possivel atualizar o usuario.");
  revalidatePath("/configuracoes/usuarios");
  redirectWith("sucesso", "Usuario atualizado com sucesso.");
}

export async function resetPasswordAction(formData: FormData) {
  if (!(await requireMaster())) redirect("/acesso-negado");
  const id = String(formData.get("id") || "");
  const password = String(formData.get("password") || "");
  const confirmation = String(formData.get("passwordConfirmation") || "");
  if (!id || password.length < 8) return redirectWith("erro", "A nova senha deve ter no minimo 8 caracteres.");
  if (password !== confirmation) return redirectWith("erro", "A confirmacao da senha nao confere.");

  const { error } = await supabaseAdmin()
    .from("app_users")
    .update({ password_hash: await hashPassword(password), session_version: await nextSessionVersion(id) })
    .eq("id", id);
  if (error) return redirectWith("erro", "Nao foi possivel redefinir a senha.");
  revalidatePath("/configuracoes/usuarios");
  redirectWith("sucesso", "Senha redefinida com sucesso.");
}

function parseUserForm(formData: FormData, passwordRequired: boolean) {
  const name = String(formData.get("name") || "").trim();
  const email = String(formData.get("email") || "").trim().toLowerCase();
  const password = String(formData.get("password") || "");
  const confirmation = String(formData.get("passwordConfirmation") || "");
  const active = formData.get("active") === "on";
  if (!name) return { error: "O nome e obrigatorio.", name, email, active };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "Informe um e-mail valido.", name, email, active };
  if (passwordRequired && password.length < 8) return { error: "A senha deve ter no minimo 8 caracteres.", name, email, active };
  if (passwordRequired && password !== confirmation) return { error: "A confirmacao da senha nao confere.", name, email, active };
  return { name, email, password, active, error: "" };
}

async function nextSessionVersion(id: string) {
  const { data } = await supabaseAdmin().from("app_users").select("session_version").eq("id", id).single();
  return Number(data?.session_version || 1) + 1;
}

function redirectWith(kind: "erro" | "sucesso", message: string): never {
  redirect(`/configuracoes/usuarios?${kind}=${encodeURIComponent(message)}`);
}
