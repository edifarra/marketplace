import { loginAction } from "./actions";
import { isAuthConfigured } from "@/lib/auth";
import { PasswordField } from "./password-field";

export const dynamic = "force-dynamic";

type LoginPageProps = {
  searchParams?: { erro?: string; next?: string; sessao?: string };
};

export default function LoginPage({ searchParams }: LoginPageProps) {
  const authConfigured = isAuthConfigured();
  const message = searchParams?.sessao === "expirada"
    ? "Sua sessao expirou. Entre novamente."
    : searchParams?.erro;

  return (
    <main className="login-shell">
      <section className="login-panel">
        <div>
          <h1>Entrar</h1>
          <div className="subtitle">Gestao de estoque e marketplaces</div>
        </div>
        {!authConfigured && (
          <div className="form-error">Configure a autenticacao no ambiente para liberar o acesso.</div>
        )}
        {message && <div className="form-error">{message}</div>}
        <form action={loginAction} className="config-form">
          <input type="hidden" name="next" value={searchParams?.next || "/"} />
          <label>
            E-mail
            <input name="email" type="email" autoComplete="username" required autoFocus disabled={!authConfigured} />
          </label>
          <PasswordField disabled={!authConfigured} />
          <button className="primary" type="submit" disabled={!authConfigured}>Entrar</button>
        </form>
      </section>
    </main>
  );
}
