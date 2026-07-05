"use client";

import { useState } from "react";

type StockSyncProgress = {
  status: "idle" | "running" | "done" | "failed";
  totalFiles: number;
  processedFiles: number;
  syncedProducts: number;
  percent: number;
  message: string;
};

type StockSyncButtonProps = {
  accountId: string;
  accountName: string;
};

export function StockSyncButton({ accountId, accountName }: StockSyncButtonProps) {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<StockSyncProgress | null>(null);

  async function run() {
    setRunning(true);
    const start = await postProgress("start");
    if (start) {
      setProgress(start);
    }

    let next = start;
    while (next?.status === "running") {
      next = await postProgress("step");
      if (next) {
        setProgress(next);
      }
    }

    setRunning(false);
    window.location.reload();
  }

  async function postProgress(action: "start" | "step") {
    return fetch(`/api/estoque/sync?accountId=${encodeURIComponent(accountId)}&action=${action}`, {
      method: "POST",
      cache: "no-store"
    })
      .then((response) => response.json())
      .then((json) => json.progress as StockSyncProgress)
      .catch(() => null);
  }

  const percent = Math.max(0, Math.min(100, Number(progress?.percent || 0)));

  return (
    <div className="progress-action">
      <button className="primary compact" type="button" onClick={run} disabled={running}>
        {running ? `Sincronizando ${accountName}` : `Sincronizar ${accountName}`}
      </button>
      {(running || progress) && (
        <div className="progress-box">
          <div className="progress-bar">
            <span style={{ width: `${percent}%` }} />
          </div>
          <div className="muted">{formatMessage(progress)}</div>
        </div>
      )}
    </div>
  );
}

function formatMessage(progress: StockSyncProgress | null) {
  if (!progress) {
    return "Aguardando sincronizacao.";
  }

  if (progress.status === "done") {
    return `${progress.syncedProducts || 0} produtos sincronizados.`;
  }

  if (progress.status === "failed") {
    return progress.message || "Falha na sincronizacao.";
  }

  return `${progress.processedFiles || 0} de ${progress.totalFiles || 0}.`;
}
