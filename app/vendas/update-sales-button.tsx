"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function UpdateSalesButton() {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);

  async function updateSales() {
    setRunning(true);
    setMessage("");
    setFailed(false);
    try {
      const response = await fetch("/api/vendas/atualizar", { method: "POST", cache: "no-store" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Nao foi possivel atualizar os pedidos.");
      setMessage(`${Number(result.checked || 0)} pedidos conferidos; ${Number(result.updated || 0)} atualizados.`);
      router.refresh();
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error ? error.message : "Nao foi possivel atualizar os pedidos.");
    } finally {
      setRunning(false);
    }
  }

  return <div className="progress-action">
    <button className="primary" type="button" disabled={running} onClick={updateSales}>
      {running ? "Atualizando pedidos..." : "Atualizar"}
    </button>
    {message && <div className={failed ? "sale-action-error" : "muted"}>{message}</div>}
  </div>;
}
