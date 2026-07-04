/** Local-time `YYYY-MM-DD` — toISOString() would shift the date across UTC boundaries. */
export function localDateIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Local-time `YYYY-MM-DD HH:MM`. */
export function localMinuteIso(d: Date = new Date()): string {
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${localDateIso(d)} ${hh}:${mm}`;
}
