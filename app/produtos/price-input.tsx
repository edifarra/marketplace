"use client";

import { useState } from "react";
import { parsePriceValue } from "@/lib/price-value";

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

  return <input
      form={form}
      name={name}
      className={className}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      required={required}
      value={displayValue}
      onChange={(event) => {
        setDisplayValue(event.target.value);
      }}
      onBlur={() => {
        const parsed = parsePriceValue(displayValue);
        if (parsed === null) {
          setDisplayValue("");
          return;
        }
        setDisplayValue(formatPrice(parsed));
      }}
    />;
}

export const parsePrice = parsePriceValue;

function finitePrice(value: number): number | null {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function formatPrice(value: number) {
  return value.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
