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

/**
 * The instant a {@link localMinuteIso} stamp names, read back in local time.
 * `null` for anything that is not exactly that shape or not a real date.
 */
export function parseLocalMinuteIso(text: string): Date | null {
  const m = text.trim().match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/);
  if (m === null) return null;
  const [year, month, day, hours, minutes] = m.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const date = new Date(year, month - 1, day, hours, minutes);
  return localMinuteIso(date) === text.trim() ? date : null;
}
