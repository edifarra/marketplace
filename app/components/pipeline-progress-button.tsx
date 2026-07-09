"use client";

import { useEffect, useState } from "react";

type ProgressState = {
  status: string;
  totalFiles: number;
  processedFiles: number;
  percent: number;
  message?: string;
};

type RunResponse = {
  ok?: boolean;
  message?: string;
  error?: string;
  drive?: {
    totalTransferable?: number;
    totalMoved?: number;
    totalCopied?: number;
    totalFailed?: number;
  };
};

type PipelineProgressButtonProps = {
  endpoint: string;
  progressEndpoint: string;
  idleLabel: string;
  runningLabel: string;
  disabled?: boolean;
};

export function PipelineProgressButton({
  endpoint,
  progressEndpoint,
  idleLabel,
  runningLabel,
  disabled = false
}: PipelineProgressButtonProps) {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ProgressState | null>(null);

  useEffect(() => {
    if (!running) {
      return;
    }

    const timer = window.setInterval(async () => {
      const next = await fetch(progressEndpoint, { cache: "no-store" })
        .then((response) => response.json())
        .then((json) => json.progress as ProgressState)
        .catch(() => null);

      if (next) {
        setProgress(next);
      }
    }, 1000);

    return () => window.clearInterval(timer);
  }, [progressEndpoint, running]);

  async function run() {
    setRunning(true);
    setProgress({
      status: "running",
      totalFiles: 0,
      processedFiles: 0,
      percent: 0,
      message: runningLabel
    });

    const response = await fetch(endpoint, {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin"
    }).catch(() => null);

    const result = await response?.json().catch(() => null) as RunResponse | null;

    if (!response?.ok) {
      setProgress({
        status: "failed",
        totalFiles: 0,
        processedFiles: 0,
        percent: 0,
        message: result?.error || "Nao foi possivel executar agora."
      });
      setRunning(false);
      return;
    }

    if (result?.message) {
      setProgress({
        status: "done",
        totalFiles: Number(result.drive?.totalTransferable || 0),
        processedFiles: Number(result.drive?.totalMoved || 0) + Number(result.drive?.totalCopied || 0) + Number(result.drive?.totalFailed || 0),
        percent: 100,
        message: result.message
      });
    }

    const finalProgress = await fetch(progressEndpoint, { cache: "no-store" })
      .then((response) => response.json())
      .then((json) => json.progress as ProgressState)
      .catch(() => null);

    if (finalProgress) {
      setProgress(finalProgress);
    }
    setRunning(false);
    window.setTimeout(() => {
      const url = new URL(window.location.href);
      url.searchParams.set("pipelineRefresh", String(Date.now()));
      url.hash = "pipeline";
      window.location.replace(url.toString());
    }, 1200);
  }

  const percent = Math.max(0, Math.min(100, Number(progress?.percent || 0)));

  return (
    <div className="progress-action">
      <button className="primary compact" type="button" onClick={run} disabled={disabled || running}>
        {running ? runningLabel : idleLabel}
      </button>
      {(running || progress?.status === "failed") && (
        <div className="progress-box">
          <div className="progress-bar">
            <span style={{ width: `${percent}%` }} />
          </div>
          <div className="muted">{formatProgressMessage(progress)}</div>
        </div>
      )}
    </div>
  );
}

function formatProgressMessage(progress: ProgressState | null) {
  if (!progress) {
    return "Fotos processados 0 de 0. (0%).";
  }

  if (progress.message) {
    return progress.message;
  }

  return `Fotos processados ${progress.processedFiles || 0} de ${progress.totalFiles || 0}. (${Math.round(Number(progress.percent || 0))}%).`;
}
