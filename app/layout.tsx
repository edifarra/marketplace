import "./globals.css";
import type { Metadata } from "next";
import { GlobalMarketplaceNotifications } from "@/app/components/global-marketplace-notifications";

export const metadata: Metadata = {
  title: { default: "Gestão Marketplace.tech", template: "%s | Gestão Marketplace.tech" },
  description: "Controle de produtos, estoque e anuncios para Mercado Livre e Shopee"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>
        {children}
        <GlobalMarketplaceNotifications />
      </body>
    </html>
  );
}
