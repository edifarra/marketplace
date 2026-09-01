"use client";

import { useState } from "react";

export function PriceInput({
  name = "price",
  initialValue,
  className = "product-price-input",
  required = false,
  form
}: {
  name?: string;
  initialValue: number;
  className?: string;
  required?: boolean;
  form?: string;
}) {
  const initialPrice = finitePrice(initialValue) ?? 0;
  const [displayValue, setDisplayValue] = useState(() => formatPrice(initialPrice));
  const [submittedValue, setSubmittedValue] = useState(() => initialPrice.toFixed(2));

  return <>
    <input
      className={className}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      required={required}
      value={displayValue}
      onChange={(event) => {
        const next = event.target.value;
        setDisplayValue(next);
        const parsed = parsePrice(next);
        setSubmittedValue(parsed === null ? "" : parsed.toFixed(2));
      }}
      onBlur={() => {
        const parsed = parsePrice(displayValue);
        if (parsed === null) {
          setDisplayValue("");
          setSubmittedValue("");
          return;
        }
        setDisplayValue(formatPrice(parsed));
        setSubmittedValue(parsed.toFixed(2));
      }}
    />
    <input form={form} type="hidden" name={name} value={submittedValue} />
  </>;
}

export function parsePrice(value: string): number | null {
  const cleaned = value.trim().replace(/R\$/gi, "").replace(/\s/g, "");
  if (!cleaned) return null;
  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");
  const decimalIndex = Math.max(lastComma, lastDot);
  const integerPart = decimalIndex >= 0 ? cleaned.slice(0, decimalIndex) : cleaned;
  const decimalPart = decimalIndex >= 0 ? cleaned.slice(decimalIndex + 1) : "";
  const normalized = `${integerPart.replace(/\D/g, "")}${decimalIndex >= 0 ? `.${decimalPart.replace(/\D/g, "")}` : ""}`;
  const parsed = Number(normalized);
  return finitePrice(parsed);
}

function finitePrice(value: number): number | null {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function formatPrice(value: number) {
  return value.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
