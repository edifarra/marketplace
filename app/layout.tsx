import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Estoque e Marketplaces",
  description: "Controle de produtos, estoque e anuncios para Mercado Livre e Shopee"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
