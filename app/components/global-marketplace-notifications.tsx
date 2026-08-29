"use client";

import { useEffect, useRef, useState } from "react";

type MarketplaceNotification = {
  id: string;
  kind: "sale" | "message";
  marketplace: "mercado_livre" | "shopee";
  title: string;
  customer?: string;
  description: string;
  occurredAt: string;
  href: string;
};

const POLL_INTERVAL = 12_000;

export function GlobalMarketplaceNotifications() {
  const [notifications, setNotifications] = useState<MarketplaceNotification[]>([]);
  const cursor = useRef<string | null>(null);
  const known = useRef(new Set<string>());

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      try {
        const query = cursor.current ? `?after=${encodeURIComponent(cursor.current)}` : "";
        const response = await fetch(`/api/notifications${query}`, { cache: "no-store" });
        if (!response.ok) return;
        const payload = await response.json() as { checkedAt: string; notifications: MarketplaceNotification[] };
        cursor.current = payload.checkedAt;

        // A primeira consulta estabelece o ponto de partida e não anuncia registros antigos.
        if (!query) return;
        const fresh = payload.notifications.filter(item => !known.current.has(item.id));
        fresh.forEach(item => known.current.add(item.id));
        if (fresh.length) setNotifications(current => [...fresh, ...current].slice(0, 5));
      } catch {
        // Uma falha temporária não interrompe as próximas verificações.
      } finally {
        if (active) timer = setTimeout(poll, POLL_INTERVAL);
      }
    };

    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, []);

  const dismiss = (id: string) => setNotifications(current => current.filter(item => item.id !== id));

  return <aside className="marketplace-notification-stack" aria-live="polite" aria-label="Novidades dos marketplaces">
    {notifications.map(item => <article className={`marketplace-notification ${item.kind}`} key={item.id}>
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
