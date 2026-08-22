"use client";

import { useFormStatus } from "react-dom";
import { useEffect, useState } from "react";

export function ProductActionSubmit({ label, pendingLabel = label, danger = false }: { label: string; pendingLabel?: string; danger?: boolean }) {
  const { pending } = useFormStatus();
  return <button className={`${danger ? "danger" : "secondary"} compact product-action-button${pending ? " processing" : ""}`} type="submit" disabled={pending} aria-busy={pending}>
    <span>{pending ? pendingLabel : label}</span>
    {pending && <span className="action-dots" aria-hidden="true"><i /><i /><i /></span>}
  </button>;
}

export function ExternalProductActionSubmit({ label, form, pendingLabel = "Salvando", name, value, requireAvailableStock = false }: { label: string; form: string; pendingLabel?: string; name?: string; value?: string; requireAvailableStock?: boolean }) {
  const [pending, setPending] = useState(false);
  const [stockUnavailable, setStockUnavailable] = useState(requireAvailableStock);

  useEffect(() => {
    const formElement = document.getElementById(form) as HTMLFormElement | null;
    if (!formElement) return;

    // A valid submit is the source of truth. A click can be cancelled by native
    // form validation, which previously left this external button stuck forever.
    const handleSubmit = () => setPending(true);
    const handleInvalid = () => setPending(false);
    const stockInput = formElement.elements.namedItem("stock") as HTMLInputElement | null;
    const refreshStockAvailability = () => {
      if (!requireAvailableStock) return;
      const physical = Math.max(0, Number(stockInput?.value || 0));
      const reserved = Math.max(0, Number(stockInput?.dataset.reservedStock || 0));
      setStockUnavailable(physical - reserved <= 0);
    };
    refreshStockAvailability();
    formElement.addEventListener("submit", handleSubmit);
    formElement.addEventListener("invalid", handleInvalid, true);
    stockInput?.addEventListener("input", refreshStockAvailability);
    return () => {
      formElement.removeEventListener("submit", handleSubmit);
      formElement.removeEventListener("invalid", handleInvalid, true);
      stockInput?.removeEventListener("input", refreshStockAvailability);
    };
  }, [form, requireAvailableStock]);

  const preserveSubmitIntent = () => {
    const formElement = document.getElementById(form) as HTMLFormElement | null;
    const intent = formElement?.elements.namedItem("intent") as HTMLInputElement | null;
    if (intent) intent.value = name === "intent" ? String(value || "") : "";
  };

  return <button className={`secondary compact product-action-button${pending ? " processing" : ""}`} type="submit" form={form} onClick={preserveSubmitIntent} disabled={pending || stockUnavailable} aria-busy={pending} title={stockUnavailable ? "Estoque disponível deve ser maior que zero para enviar." : undefined}>
    <span>{pending ? pendingLabel : label}</span>
    {pending && <span className="action-dots" aria-hidden="true"><i /><i /><i /></span>}
  </button>;
}
