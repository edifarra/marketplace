import { loginAction } from "./actions";
import { isAuthConfigured } from "@/lib/auth";

export const dynamic = "force-dynamic";

type LoginPageProps = {
  searchParams?: {
    erro?: string;
    next?: string;
  };
};

export default function LoginPage({ searchParams }: LoginPageProps) {
  const authConfigured = isAuthConfigured();

  return (
    <main className="login-shell">
      <section className="login-panel">
        <div>
          <h1>Entrar</h1>
          <div className="subtitle">Acesso restrito ao painel de estoque e marketplaces.</div>
        </div>

        {!authConfigured && (
          <div className="form-error">
            Configure SITE_PASSWORD no Vercel para ativar a tela de login.
          </div>
        )}

        {searchParams?.erro && <div className="form-error">{searchParams.erro}</div>}

        <form action={loginAction} className="config-form">
          <input type="hidden" name="next" value={searchParams?.next || "/"} />
          <label>
            Senha
            <input name="password" type="password" required autoFocus disabled={!authConfigured} />
          </label>
          <button className="primary" type="submit" disabled={!authConfigured}>
            Acessar
          </button>
        </form>
      </section>
    </main>
  );
}
