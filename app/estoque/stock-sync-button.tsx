"use client";

import { useEffect, useRef, useState } from "react";

type StockSyncProgress = {
  status: "idle" | "running" | "done" | "failed";
  totalFiles: number;
  processedFiles: number;
  syncedProducts: number;
  percent: number;
  message: string;
  phase?: "prepare" | "listing" | "existing" | "migration" | "deletion" | "done";
  migratedProducts?: number;
  deletedProducts?: number;
  failedProducts?: number;
};

type StockSyncButtonProps = {
  accountId: string;
  accountName: string;
};

export function StockSyncButton({ accountId, accountName }: StockSyncButtonProps) {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<StockSyncProgress | null>(null);
  const reloadedAfterCompletion = useRef(false);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function refresh() {
      const current = await getProgress();
      const next = current?.status === "running" && accountId !== "tiny"
        ? await postProgress("step")
        : current;
      if (!active) return;
      if (next) {
        setProgress(next);
        setRunning(next.status === "running");
        if (next.status === "running") {
          timer = setTimeout(refresh, 2500);
          return;
        }
        if (reloadedAfterCompletion.current) {
          reloadedAfterCompletion.current = false;
          window.location.reload();
        }
      }
      timer = setTimeout(refresh, 10000);
    }

    void refresh();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
    // As funcoes usam somente o accountId desta instancia do botao.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  async function run() {
    setRunning(true);
    const start = await postProgress("start");
    if (start) {
      setProgress(start);
      setRunning(start.status === "running");
      reloadedAfterCompletion.current = start.status === "running";
    } else {
      setRunning(false);
    }
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

  async function getProgress() {
    return fetch(`/api/estoque/sync?accountId=${encodeURIComponent(accountId)}`, {
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

  return progress.message || `${progress.processedFiles || 0} processados.`;
}
