export default function AccessDeniedPage() {
  return (
    <main className="login-shell">
      <section className="login-panel">
        <h1>Acesso negado</h1>
        <div className="form-error">Voce nao possui autorizacao para acessar esta pagina.</div>
        <a className="primary link-button" href="/">Voltar ao Painel</a>
      </section>
    </main>
  );
}
