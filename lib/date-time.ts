const SAO_PAULO_TIME_ZONE = "America/Sao_Paulo";

export function formatSaoPauloDateTime(value: string | Date) {
  return new Date(value).toLocaleString("pt-BR", { timeZone: SAO_PAULO_TIME_ZONE });
}
