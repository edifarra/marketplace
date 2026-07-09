"use client";

import { useEffect, useState } from "react";

type ProgressState = {
  status: string;
  totalFiles: number;
  processedFiles: number;
  percent: number;
  currentFile?: string;
  message?: string;
};

export function ProductLoadButton() {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ProgressState | null>(null);

  useEffect(() => {
    if (!running) {
      return;
    }

    const timer = window.setInterval(async () => {
      const next = await fetch("/api/pipeline/products/progress", { cache: "no-store" })
        .then((response) => response.json())
        .then((json) => json.progress as ProgressState)
        .catch(() => null);

      if (next) {
        setProgress(next);
        if (["done", "failed"].includes(next.status)) {
          setRunning(false);
        }
      }
    }, 1000);

    return () => window.clearInterval(timer);
  }, [running]);

  async function run() {
    setRunning(true);
    setProgress({
      status: "running",
      totalFiles: 0,
      processedFiles: 0,
      percent: 0,
      message: "Iniciando carregamento..."
    });

    await fetch("/api/pipeline/products?force=1", {
      method: "POST",
      cache: "no-store"
    }).catch(() => null);

    const finalProgress = await fetch("/api/pipeline/products/progress", { cache: "no-store" })
      .then((response) => response.json())
      .then((json) => json.progress as ProgressState)
      .catch(() => null);

    if (finalProgress) {
      setProgress(finalProgress);
    }
    setRunning(false);
    window.location.reload();
  }

  const percent = Math.max(0, Math.min(100, Number(progress?.percent || 0)));

  return (
    <div className="progress-action">
      <button className="primary compact" type="button" onClick={run} disabled={running}>
        {running ? `Carregando ${percent}%` : "Carregar Agora"}
      </button>
      {(running || progress) && (
        <div className="progress-box">
          <div className="progress-bar">
            <span style={{ width: `${percent}%` }} />
          </div>
          <div className="muted">
            {formatProgressMessage(progress)}
          </div>
        </div>
      )}
    </div>
  );
}

function formatProgressMessage(progress: ProgressState | null) {
  if (!progress) {
    return "Aguardando progresso.";
  }

  if (progress.totalFiles > 0) {
    return `Fotos processados ${progress.processedFiles} de ${progress.totalFiles}. (${progress.percent}%).`;
  }

  return "Fotos processados 0 de 0. (0%).";
}
