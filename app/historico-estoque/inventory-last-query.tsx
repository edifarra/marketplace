"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

const STORAGE_KEY = "gestao-marketplace:last-inventory-query";
const SCROLL_KEY = "gestao-marketplace:last-inventory-scroll";

export function InventoryLastQuery({ currentQuery }: { currentQuery: string }) {
  const router = useRouter();

  useEffect(() => {
    if (currentQuery) {
      window.localStorage.setItem(STORAGE_KEY, currentQuery);
      const savedScroll = Number(window.sessionStorage.getItem(`${SCROLL_KEY}:${currentQuery}`) || 0);
      const frame = window.requestAnimationFrame(() => window.scrollTo({ top: savedScroll }));
      const savePosition = () => window.sessionStorage.setItem(`${SCROLL_KEY}:${currentQuery}`, String(window.scrollY));
      window.addEventListener("scroll", savePosition, { passive: true });
      return () => {
        window.cancelAnimationFrame(frame);
        savePosition();
        window.removeEventListener("scroll", savePosition);
      };
    }

    const savedQuery = window.localStorage.getItem(STORAGE_KEY);
    if (savedQuery) router.replace(`/historico-estoque?${savedQuery}`);
  }, [currentQuery, router]);

  return null;
}
