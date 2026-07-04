/**
 * Spanish relative-date humanizer (es-PE). Pure, no I/O, no clock — `now` is
 * injected so callers (and tests) stay deterministic. Mirrors the `options.now`
 * precedent in `lock-service` / `checkpoint-service`.
 *
 * Produces friendly, direct strings: "recién", "hace 5 minutos", "hoy en la
 * mañana", "ayer en la tarde", "hace 3 días", "la semana pasada", "hace 2
 * semanas", "hace un mes", "hace 4 meses", "hace un año", "hace 2 años".
 *
 * Day/week deltas are computed over LOCAL calendar dates (not raw 24h spans) so
 * "ayer" is a calendar concept; month/year deltas use calendar arithmetic.
 */

const MS_PER_MINUTE = 60_000;

/** Time-of-day band of `d`'s local clock. */
function franja(d: Date): "mañana" | "tarde" | "noche" {
  const h = d.getHours();
  if (h < 12) return "mañana";
  if (h < 19) return "tarde";
  return "noche";
}

/** Local midnight of `d`. */
function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Whole-day difference between the local calendar dates of `then` and `now`. */
function calendarDayDiff(then: Date, now: Date): number {
  const ms = startOfDay(now).getTime() - startOfDay(then).getTime();
  return Math.round(ms / 86_400_000);
}

/** Calendar-month difference (>= 0), accounting for day-of-month. */
function calendarMonthDiff(then: Date, now: Date): number {
  let m = (now.getFullYear() - then.getFullYear()) * 12 + (now.getMonth() - then.getMonth());
  if (now.getDate() < then.getDate()) m -= 1;
  return Math.max(0, m);
}

/**
 * Humanize `then` relative to `now` in Spanish. Future / clock-skew (`then`
 * ahead of `now`) clamps to "recién" — never emits a future phrase.
 */
export function humanizeRelativeEs(then: Date, now: Date): string {
  const ms = now.getTime() - then.getTime();

  // Just now / future skew.
  if (ms < MS_PER_MINUTE) return "recién";

  const minutes = Math.floor(ms / MS_PER_MINUTE);
  if (minutes < 60) return minutes === 1 ? "hace un minuto" : `hace ${minutes} minutos`;

  const days = calendarDayDiff(then, now);
  if (days === 0) return `hoy en la ${franja(then)}`;
  if (days === 1) return `ayer en la ${franja(then)}`;
  if (days <= 6) return `hace ${days} días`;
  if (days <= 13) return "la semana pasada";
  if (days <= 27) return `hace ${Math.floor(days / 7)} semanas`;

  const months = calendarMonthDiff(then, now);
  if (months <= 1) return "hace un mes";
  if (months <= 11) return `hace ${months} meses`;

  const years = Math.floor(months / 12);
  return years === 1 ? "hace un año" : `hace ${years} años`;
}
