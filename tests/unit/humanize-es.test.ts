import { describe, expect, it } from "vitest";
import { humanizeRelativeEs } from "../../src/application/humanize-es.js";

// Fixed reference instant: Sun 2026-06-21 15:00:00 local. All `at` dates are
// built with the numeric constructor (month is 0-indexed; 5 = June) so the test
// is timezone-independent.
const NOW = new Date(2026, 5, 21, 15, 0, 0);

describe("humanizeRelativeEs", () => {
  const cases: Array<{ label: string; at: Date; expected: string }> = [
    // recién / future-skew
    { label: "future (clock skew)", at: new Date(2026, 5, 21, 16, 0, 0), expected: "recién" },
    { label: "30s ago", at: new Date(2026, 5, 21, 14, 59, 30), expected: "recién" },
    { label: "exactly now", at: new Date(2026, 5, 21, 15, 0, 0), expected: "recién" },
    // minutes
    { label: "1 min", at: new Date(2026, 5, 21, 14, 59, 0), expected: "hace un minuto" },
    { label: "5 min", at: new Date(2026, 5, 21, 14, 55, 0), expected: "hace 5 minutos" },
    { label: "59 min", at: new Date(2026, 5, 21, 14, 1, 0), expected: "hace 59 minutos" },
    // today (franja)
    { label: "hoy mañana", at: new Date(2026, 5, 21, 9, 0, 0), expected: "hoy en la mañana" },
    { label: "hoy tarde", at: new Date(2026, 5, 21, 12, 30, 0), expected: "hoy en la tarde" },
    // yesterday (franja)
    { label: "ayer mañana", at: new Date(2026, 5, 20, 9, 0, 0), expected: "ayer en la mañana" },
    { label: "ayer tarde", at: new Date(2026, 5, 20, 14, 0, 0), expected: "ayer en la tarde" },
    { label: "ayer noche", at: new Date(2026, 5, 20, 20, 0, 0), expected: "ayer en la noche" },
    // days
    { label: "2 días", at: new Date(2026, 5, 19, 15, 0, 0), expected: "hace 2 días" },
    { label: "6 días", at: new Date(2026, 5, 15, 15, 0, 0), expected: "hace 6 días" },
    // last week
    { label: "7 días", at: new Date(2026, 5, 14, 15, 0, 0), expected: "la semana pasada" },
    { label: "13 días", at: new Date(2026, 5, 8, 15, 0, 0), expected: "la semana pasada" },
    // weeks
    { label: "14 días", at: new Date(2026, 5, 7, 15, 0, 0), expected: "hace 2 semanas" },
    { label: "21 días", at: new Date(2026, 4, 31, 15, 0, 0), expected: "hace 3 semanas" },
    // months
    { label: "28 días (mes)", at: new Date(2026, 4, 24, 15, 0, 0), expected: "hace un mes" },
    { label: "1 mes calendario", at: new Date(2026, 4, 21, 15, 0, 0), expected: "hace un mes" },
    { label: "2 meses", at: new Date(2026, 3, 21, 15, 0, 0), expected: "hace 2 meses" },
    { label: "11 meses", at: new Date(2025, 6, 21, 15, 0, 0), expected: "hace 11 meses" },
    // years
    { label: "1 año", at: new Date(2025, 5, 21, 15, 0, 0), expected: "hace un año" },
    { label: "2 años", at: new Date(2024, 5, 21, 15, 0, 0), expected: "hace 2 años" },
  ];

  for (const { label, at, expected } of cases) {
    it(`${label} → "${expected}"`, () => {
      expect(humanizeRelativeEs(at, NOW)).toBe(expected);
    });
  }

  it("'ayer' es calendario, no 24h (2h de diferencia cruzando medianoche)", () => {
    const now = new Date(2026, 5, 21, 1, 0, 0); // today 01:00
    const at = new Date(2026, 5, 20, 23, 0, 0); // yesterday 23:00
    expect(humanizeRelativeEs(at, now)).toBe("ayer en la noche");
  });

  it("'hoy' aunque sean ~22h, si es el mismo día calendario", () => {
    const now = new Date(2026, 5, 21, 23, 0, 0); // today 23:00
    const at = new Date(2026, 5, 21, 0, 30, 0); // today 00:30
    expect(humanizeRelativeEs(at, now)).toBe("hoy en la mañana");
  });
});
