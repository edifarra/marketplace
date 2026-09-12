export function parsePriceValue(value: unknown): number | null {
  const cleaned = String(value ?? "").trim().replace(/R\$/gi, "").replace(/\s/g, "");
  if (!cleaned) return null;

  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");
  const decimalIndex = Math.max(lastComma, lastDot);
  const integerPart = decimalIndex >= 0 ? cleaned.slice(0, decimalIndex) : cleaned;
  const decimalPart = decimalIndex >= 0 ? cleaned.slice(decimalIndex + 1) : "";
  const normalized = `${integerPart.replace(/\D/g, "")}${decimalIndex >= 0 ? `.${decimalPart.replace(/\D/g, "")}` : ""}`;
  const parsed = Number(normalized);

  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
