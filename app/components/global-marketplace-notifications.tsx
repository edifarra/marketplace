"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import {
  GlobalMarketplaceNotificationPoller,
  MarketplaceNotification,
  MarketplaceNotificationPage,
  mergeMarketplaceNotifications,
  notificationCursorQuery
} from "@/lib/global-marketplace-notifications";

export function GlobalMarketplaceNotifications() {
  const pathname = usePathname();
  const centralReadOnly = pathname === "/central-reclamacoes" || pathname?.startsWith("/central-reclamacoes/");
  const [notifications, setNotifications] = useState<MarketplaceNotification[]>([]);
  useEffect(() => {
    if (centralReadOnly) return;
    const poller = new GlobalMarketplaceNotificationPoller({
      visibility: () => document.visibilityState,
      fetchPage: async (cursor, until) => {
        const response = await fetch(`/api/notifications${notificationCursorQuery(cursor, until)}`, { cache: "no-store" });
        if (!response.ok) throw new Error("Não foi possível consultar as notificações.");
        return response.json() as Promise<MarketplaceNotificationPage>;
      },
      onNotifications: fresh => {
        setNotifications(current => mergeMarketplaceNotifications(current, fresh));
      }
    });

    const handleVisibilityChange = () => { void poller.visibilityChanged(); };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    void poller.start();
    return () => {
      poller.stop();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [centralReadOnly]);

  const dismiss = (id: string) => setNotifications(current => current.filter(item => item.id !== id));

  if (centralReadOnly) return null;
  return <aside className="marketplace-notification-stack" aria-live="polite" aria-label="Novidades dos marketplaces">
    {notifications.slice(0, 5).map(item => <article className={`marketplace-notification ${item.kind}`} key={item.id}>
      <a href={item.href} className="marketplace-notification-content">
        <img src={item.marketplace === "mercado_livre" ? "/marketplaces/mercado-livre-mini.png" : "/marketplaces/shopee-mini.webp"} alt={item.marketplace === "mercado_livre" ? "Mercado Livre" : "Shopee"}/>
        <span className="marketplace-notification-copy">
          <strong>{item.title}</strong>
          {item.customer && <span className="marketplace-notification-customer">{item.customer}</span>}
          <span>{item.description}</span>
        </span>
      </a>
      <button type="button" onClick={() => dismiss(item.id)} aria-label="Fechar notificação">×</button>
    </article>)}
  </aside>;
}
