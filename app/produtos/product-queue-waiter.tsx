"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type Activity = { id: string; status: string; processing_error?: string | null };

export function ProductQueueWaiter({ activityIds, returnTo, initialMessage }: { activityIds: string[]; returnTo: string; initialMessage: string }) {
  const router = useRouter();
  const [message, setMessage] = useState(initialMessage);

  useEffect(() => {
    let active = true;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const check = async () => {
      try {
        const response = await fetch(`/api/outgoing-activities/status?ids=${encodeURIComponent(activityIds.join(","))}`, { cache: "no-store" });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Não foi possível consultar a fila.");
        const activities = (payload.activities || []) as Activity[];
        const failed = activities.find(item => item.status === "error");
        if (failed) {
          router.replace(`${returnTo}${returnTo.includes("?") ? "&" : "?"}erro=${encodeURIComponent(failed.processing_error || "O envio terminou com erro.")}`);
          router.refresh();
          return;
        }
        if (activities.length === activityIds.length && activities.every(item => item.status === "completed")) {
          router.replace(`${returnTo}${returnTo.includes("?") ? "&" : "?"}sucesso=${encodeURIComponent("Fila concluída e vínculo atualizado com sucesso.")}`);
          router.refresh();
          return;
        }
        const processing = activities.filter(item => item.status === "processing").length;
        const completed = activities.filter(item => item.status === "completed").length;
        if (active) setMessage(`Aguardando execução da fila: ${completed}/${activityIds.length} concluída(s)${processing ? `, ${processing} em processamento` : ""}.`);
        if (active) timeout = setTimeout(check, 1500);
      } catch (error) {
        if (active) setMessage(error instanceof Error ? error.message : String(error));
        if (active) timeout = setTimeout(check, 3000);
      }
    };
    check();
    return () => { active = false; if (timeout) clearTimeout(timeout); };
  }, [activityIds, returnTo, router]);

  return <div className="form-success" role="status" aria-live="polite">{message}</div>;
}
