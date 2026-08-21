"use client";

import { useState } from "react";

export function CopySkuButton({ sku }: { sku: string }) {
  const [copied, setCopied] = useState(false);

  async function copySku() {
    await navigator.clipboard.writeText(sku);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <button
      type="button"
      className="copy-sku-button"
      onClick={copySku}
      aria-label={`Copiar SKU ${sku}`}
      title={copied ? "SKU copiado" : "Copiar SKU"}
    >
      {copied ? (
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg>
      ) : (
        <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3" /></svg>
      )}
    </button>
  );
}
