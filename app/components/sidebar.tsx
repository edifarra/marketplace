import { logoutAction } from "../login/actions";
import { getCurrentUser } from "@/lib/auth";

const configLinks = [
  ["Tipo", "/configuracoes/tipo"],
  ["Marca", "/configuracoes/marca"],
  ["Especial", "/configuracoes/especial"],
  ["Preco", "/configuracoes/preco"],
  ["Sku", "/configuracoes/sku"],
  ["MarketPlace", "/configuracoes/marketplace"],
  ["Categorias Marketplace", "/configuracoes/categorias-marketplace"],
  ["Status de Vendas", "/configuracoes/status-vendas"],
  ["Tiny", "/configuracoes/tiny"],
  ["GoogleDrive", "/configuracoes/google-drive"],
  ["Cloudinary", "/configuracoes/cloudinary"],
  ["ConfigGeral", "/configuracoes/config-geral"]
];

export async function Sidebar() {
  const user = await getCurrentUser();
  return (
    <aside className="sidebar">
      <div className="brand">Estoque ML/Shopee</div>
      <nav className="nav">
        <a href="/">Painel</a>
        <a href="/vendas">Vendas</a>
        <a href="/produtos">Produtos e anuncios</a>
        <a href="/historico-estoque">Estoque</a>
        <a href="/estoque">Migração de Estoque</a>
        <a href="/fotos">Fotos</a>
        <a href="/avaliacao-preco">Avaliação de Preço</a>
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
            {user?.isMaster && <a href="/configuracoes/usuarios">Usuarios</a>}
          </div>
        </details>
        <a href="/integracoes">Integracoes</a>
        {user && <div className="nav-user">Usuario: {user.name}</div>}
        <form action={logoutAction}>
          <button className="nav-logout" type="submit">Sair</button>
        </form>
      </nav>
    </aside>
  );
}
