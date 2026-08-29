import { loginAction } from "./actions";
import { getMissingAuthConfiguration, isAuthConfigured } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { PasswordField } from "./password-field";

export const dynamic = "force-dynamic";

type LoginPageProps = {
  searchParams?: { erro?: string; next?: string; sessao?: string };
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const authConfigured = isAuthConfigured();
  const missingConfiguration = getMissingAuthConfiguration();
  let compactLogo = "";
  let fullLogo = "";

  if (authConfigured) {
    const { data } = await supabaseAdmin()
      .from("settings")
      .select("key,value")
      .in("key", ["SYSTEM_COMPACT_LOGO_URL", "SYSTEM_FULL_LOGO_URL"]);
    const value = (key: string) => String(data?.find(row => row.key === key)?.value || "").replace(/^"|"$/g, "");
    compactLogo = value("SYSTEM_COMPACT_LOGO_URL");
    fullLogo = value("SYSTEM_FULL_LOGO_URL");
  }
  const message = searchParams?.sessao === "expirada"
    ? "Sua sessao expirou. Entre novamente."
    : searchParams?.erro;

  return (
    <main className="login-shell">
      <section className="login-panel">
        <div className="login-brand" aria-label="Gestao Marketplace.tech">
          {compactLogo ? <img className="login-brand-logo" src={compactLogo} alt="Logo" /> : <span className="login-brand-logo-fallback">GM</span>}
          {fullLogo ? <img className="login-brand-name" src={fullLogo} alt="Gestao Marketplace.tech" /> : <strong>Gestão<br />Marketplace<span>.tech</span></strong>}
        </div>
        {!authConfigured && (
          <div className="form-error">
            Configure a autenticacao no ambiente para liberar o acesso.
            <div>Variaveis ausentes: {missingConfiguration.join(", ")}.</div>
          </div>
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
