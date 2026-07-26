import { redirect } from "next/navigation";
import { Sidebar } from "@/app/components/sidebar";
import { requireMaster } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { createUserAction, resetPasswordAction, updateUserAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function UsersPage({
  searchParams
}: {
  searchParams?: { erro?: string; sucesso?: string };
}) {
  if (!(await requireMaster())) redirect("/acesso-negado");
  const { data: users, error } = await supabaseAdmin()
    .from("app_users")
    .select("id,name,email,is_master,active,last_login_at,created_at")
    .order("created_at");
  if (error) throw error;

  return (
    <main className="shell">
      <Sidebar />
      <section className="main">
        <div className="topbar">
          <div><h1>Usuarios</h1><div className="subtitle">Criacao e gerenciamento basico de acessos.</div></div>
        </div>
        {searchParams?.erro && <div className="form-error">{searchParams.erro}</div>}
        {searchParams?.sucesso && <div className="form-success">{searchParams.sucesso}</div>}

        <section className="section card">
          <h2>Criar usuario</h2>
          <form action={createUserAction} className="form-grid">
            <label>Nome<input name="name" required /></label>
            <label>E-mail<input name="email" type="email" required /></label>
            <label>Senha<input name="password" type="password" minLength={8} required /></label>
            <label>Confirmacao de senha<input name="passwordConfirmation" type="password" minLength={8} required /></label>
            <label className="option-row"><input name="active" type="checkbox" defaultChecked /> Usuario ativo</label>
            <div><button className="primary" type="submit">Criar usuario</button></div>
          </form>
        </section>

        <section className="section card users-list">
          <h2>Usuarios cadastrados</h2>
          {(users || []).map((user) => (
            <article className="user-card" key={user.id}>
              <form action={updateUserAction} className="form-grid">
                <input type="hidden" name="id" value={user.id} />
                <label>Nome<input name="name" defaultValue={user.name} required /></label>
                <label>E-mail<input name="email" type="email" defaultValue={user.email} required /></label>
                <div><span className="metric-label">Tipo</span><strong>{user.is_master ? "Master" : "Usuario"}</strong></div>
                <div><span className="metric-label">Status</span><strong>{user.active ? "Ativo" : "Inativo"}</strong></div>
                <div><span className="metric-label">Ultimo login</span>{formatDate(user.last_login_at)}</div>
                <div><span className="metric-label">Criado em</span>{formatDate(user.created_at)}</div>
                <label className="option-row">
                  <input name="active" type="checkbox" defaultChecked={user.active} disabled={user.is_master} />
                  Usuario ativo
                </label>
                <div><button className="secondary" type="submit">Salvar alteracoes</button></div>
              </form>
              <form action={resetPasswordAction} className="password-reset-row">
                <input type="hidden" name="id" value={user.id} />
                <label>Nova senha<input name="password" type="password" minLength={8} required /></label>
                <label>Confirmacao<input name="passwordConfirmation" type="password" minLength={8} required /></label>
                <button className="secondary" type="submit">Redefinir senha</button>
              </form>
            </article>
          ))}
        </section>
      </section>
    </main>
  );
}

function formatDate(value: string | null) {
  if (!value) return "Nunca";
  return new Date(value).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
}
