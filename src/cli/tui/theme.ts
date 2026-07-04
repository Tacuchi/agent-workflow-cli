// Mono violet palette — handoff design_handoff_tui_simplified (v9.0.0).
// Hex strings — Ink 5 accepts `Text color="#xxx"`.
//
// Convention:
// - `accent` — the single brand accent (violet). Focus, selection, brand glyph.
// - `accentSoft` — hover state, sub-accent.
// - Text: 5 levels (bright/text/dim/mute/faint).
// - Border: 2 levels (border/borderFaint).
// - Semantic: `ok / warn / err / info / purple`.

export const palette = {
  // Highlight for focused rows — visible marker-style violet background.
  bgHighlight: "#3a2f5c",

  // borders
  borderFaint: "#1a172a",
  border: "#2a2540",

  // text (5 levels)
  bright: "#f4f1fc",
  text: "#d4d0e2",
  dim: "#9b94b8",
  mute: "#6e6588",
  faint: "#4a4368",

  // accent
  accent: "#a78bfa",
  accentSoft: "#c4b5fd",

  // semantic
  purple: "#a78bfa",
  ok: "#6ee7b7",
  warn: "#fbbf24",
  err: "#fb7185",
  info: "#93c5fd",
};

export const colors = {
  accent: palette.accent,
  accentSoft: palette.accentSoft,

  info: palette.info,
  purple: palette.purple,

  border: palette.border,
  borderFaint: palette.borderFaint,
  bgHighlight: palette.bgHighlight,

  bright: palette.bright,
  text: palette.text,
  dim: palette.dim,
  mute: palette.mute,
  faint: palette.faint,
  ok: palette.ok,
  warn: palette.warn,
  err: palette.err,
};

/**
 * Resolves a semantic tone name (the `tone` props of list rows, pills, tiles,
 * page heads) to its color. Looks up `colors` at render time so applyAccent's
 * in-place mutation keeps working.
 */
export function toneColor(
  tone?: "ok" | "warn" | "err" | "accent" | "dim" | "mute" | "purple" | "info",
  fallback: string = colors.dim,
): string {
  return tone ? colors[tone] : fallback;
}

export const icons = {
  check: "✓",
  cross: "✗",
  pending: "●",
  spinner: "⋯",
  arrow: "→",
  bullet: "·",
  diamond: "◆",
  brand: "◆",
  promptMark: "›",
  refresh: "↻",
  chevron: "›",
  // NOTE: avoid the "branch" glyph U+2387. Several terminal fonts (e.g. Warp's
  // default, on Mac and Windows) lack it and use a width-2 fallback while Ink
  // measures it as 1 → misaligns the Project tab's columns (it renders one per
  // row). U+21B3 (Arrows block) is far better supported and measures 1 cell.
  branch: "↳",
  alertDot: "●",
  pin: "⌖",
  focusBar: "▎",
} as const;

// ─── Configurable accent ────────────────────────────────────────────────────
// The accent is the single brand color (focus, selection, active borders,
// brand glyph). `applyAccent` recolors it by mutating `palette`/`colors`
// in-place: every file importing `colors` stays untouched; the re-render is
// triggered by the shell's prefs state (app.tsx). Default = violet (the
// literals above).

export type AccentColor = "violet" | "cyan" | "green" | "yellow" | "red";

export const DEFAULT_ACCENT: AccentColor = "violet";

interface AccentDef {
  main: string; // primary accent
  soft: string; // hover / sub-accent
  selBg: string; // selected-row background (dark tint of the accent)
}

// Order = swatch order in the Config tab.
export const ACCENTS: Record<AccentColor, AccentDef> = {
  violet: { main: "#a78bfa", soft: "#c4b5fd", selBg: "#3a2f5c" },
  cyan: { main: "#93c5fd", soft: "#bfdbfe", selBg: "#1e3a5c" },
  green: { main: "#6ee7b7", soft: "#a7f3d0", selBg: "#1e4d3a" },
  yellow: { main: "#fbbf24", soft: "#fcd34d", selBg: "#4d3f1e" },
  red: { main: "#fb7185", soft: "#fda4af", selBg: "#4d1e2a" },
};

export const ACCENT_ORDER: readonly AccentColor[] = ["violet", "cyan", "green", "yellow", "red"];

let currentAccent: AccentColor = DEFAULT_ACCENT;

export function getAccent(): AccentColor {
  return currentAccent;
}

/**
 * Recolors the theme in-place to the given accent. Idempotent. Tolerates
 * invalid values (falls back to violet). Called at boot (run.tsx) and
 * on-change (Config tab).
 */
export function applyAccent(accent: AccentColor): void {
  const def = ACCENTS[accent] ?? ACCENTS[DEFAULT_ACCENT];
  currentAccent = ACCENTS[accent] ? accent : DEFAULT_ACCENT;

  palette.accent = def.main;
  palette.accentSoft = def.soft;
  palette.purple = def.main;
  palette.bgHighlight = def.selBg;

  colors.accent = def.main;
  colors.accentSoft = def.soft;
  colors.purple = def.main;
  colors.bgHighlight = def.selBg;
}
