export function telegramLocalDate(date: Date, zone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function telegramDayRange(now: Date, zone: string) {
  const date = telegramLocalDate(now, zone);
  // Find local calendar boundaries, including days with DST transitions.
  const midnight = Date.parse(`${date}T00:00:00Z`);
  const boundary = (after: boolean) => {
    let low = midnight - 36 * 3600000;
    let high = midnight + 60 * 3600000;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      const local = telegramLocalDate(new Date(mid), zone);
      if (after ? local > date : local >= date) high = mid;
      else low = mid + 1;
    }
    return new Date(low).toISOString();
  };
  return { start: boundary(false), end: boundary(true) };
}

export function telegramInsideWindow(time: string, start: string, end: string) {
  start = start.slice(0, 5);
  end = end.slice(0, 5);
  return start <= end ? time >= start && time <= end : time >= start || time <= end;
}
