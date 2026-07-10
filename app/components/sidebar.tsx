import { logoutAction } from "../login/actions";

const configLinks = [
  ["Tipo", "/configuracoes/tipo"],
  ["Marca", "/configuracoes/marca"],
  ["Especial", "/configuracoes/especial"],
  ["Preco", "/configuracoes/preco"],
  ["Sku", "/configuracoes/sku"],
  ["MarketPlace", "/configuracoes/marketplace"],
  ["Categorias Marketplace", "/configuracoes/categorias-marketplace"],
  ["Tiny", "/configuracoes/tiny"],
  ["GoogleDrive", "/configuracoes/google-drive"],
  ["Cloudinary", "/configuracoes/cloudinary"],
  ["ConfigGeral", "/configuracoes/config-geral"]
];

export function Sidebar() {
  return (
    <aside className="sidebar">
      <div className="brand">Estoque ML/Shopee</div>
      <nav className="nav">
        <a href="/">Painel</a>
        <a href="/produtos">Produtos e anuncios</a>
        <a href="/estoque">Migracao e Estoque</a>
        <a href="/fotos">Fotos</a>
        <a href="/logs">Logs</a>
        <a href="/atividades-marketplace">Atividades Marketplace</a>
        <details className="nav-group" open>
          <summary>Configuracoes</summary>
          <div className="nav-submenu">
            {configLinks.map(([label, href]) => (
              <a key={href} href={href}>
                {label}
              </a>
            ))}
          </div>
        </details>
        <a href="/integracoes">Integracoes</a>
        <form action={logoutAction}>
          <button className="nav-logout" type="submit">Sair</button>
        </form>
      </nav>
    </aside>
  );
}
