/**
 * Shared relative-path guard for every write boundary.
 *
 * A path that is empty, Windows-separated, absolute, or carries `.` / `..` /
 * empty segments never reaches a filesystem call. Callers add their own
 * containment rule on top of the normalized segments — comparing SEGMENTS, so
 * `docs/specs-evil` never passes as `docs/specs`.
 */

export type SafePathCheck =
  | { ok: true; path: string; segments: string[] }
  | { ok: false; why: string };

export function checkSafeRelativePath(raw: string): SafePathCheck {
  const path = raw.trim();
  if (path.length === 0) return { ok: false, why: "está vacío" };
  if (path.includes("\\")) return { ok: false, why: "usa separador de Windows" };
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return { ok: false, why: "es absoluto" };

  const segments = path.split("/");
  if (segments.some((s) => s === ".." || s === "." || s.length === 0)) {
    return { ok: false, why: "contiene segmentos relativos o vacíos" };
  }
  return { ok: true, path, segments };
}
