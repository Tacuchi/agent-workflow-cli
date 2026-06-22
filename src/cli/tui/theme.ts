// Paleta mono violet — handoff design_handoff_tui_simplified (v9.0.0).
// Hex strings — Ink 5 acepta `Text color="#xxx"`.
//
// Convención:
// - `accent` — único acento de marca (violet). Focus, selección, brand glyph.
// - `accentSoft` — hover state, sub-accent.
// - Texto: 5 niveles (bright/text/dim/mute/faint).
// - Border: 2 niveles (border/borderFaint).
// - Semánticos: `ok / warn / err / info / purple`.

export const palette = {
  // surfaces
  bg: "#0c0a14",
  bgElev1: "#0c0a14",
  bgElev2: "#0c0a14",
  bgElev3: "#0c0a14",
  bgHover: "#1a172a",
  bgSelected: "#3a2f5c",
  // Highlight para filas focused — fondo violet visible tipo marker.
  bgHighlight: "#3a2f5c",

  // borders
  borderFaint: "#1a172a",
  border: "#2a2540",
  borderStrong: "#4a4368",
  borderAccent: "#a78bfa",

  // text (5 niveles)
  bright: "#f4f1fc",
  text: "#d4d0e2",
  dim: "#9b94b8",
  mute: "#6e6588",
  faint: "#4a4368",

  // text legacy aliases
  textBright: "#f4f1fc",
  textDim: "#9b94b8",
  textMute: "#6e6588",
  textFaint: "#4a4368",

  // accent
  accent: "#a78bfa",
  accentSoft: "#c4b5fd",

  // soportes (mantenidos para compat con codebase)
  purple: "#a78bfa",
  purpleSoft: "#c4b5fd",
  blue: "#93c5fd",
  cyan: "#93c5fd",
  green: "#6ee7b7",
  greenDim: "#34d399",
  yellow: "#fbbf24",
  orange: "#fbbf24",
  red: "#fb7185",

  // semánticos
  ok: "#6ee7b7",
  warn: "#fbbf24",
  err: "#fb7185",
  info: "#93c5fd",
};

// `colors.*` con nombres legacy + nombres canónicos del handoff.
export const colors = {
  // legacy aliases (preservados para compat con tabs v8)
  primary: palette.accent,
  accent: palette.accent,
  accentSoft: palette.accentSoft,
  secondary: palette.accentSoft,

  success: palette.ok,
  warning: palette.warn,
  error: palette.err,
  info: palette.info,
  purple: palette.purple,

  fg: palette.text,
  fgBright: palette.bright,
  fgSubtle: palette.dim,
  fgMoreSubtle: palette.mute,
  fgFaint: palette.faint,

  border: palette.border,
  borderFaint: palette.borderFaint,
  borderStrong: palette.borderStrong,
  borderActive: palette.accent,

  bg: palette.bg,
  bgElev: palette.bgElev2,
  bgHover: palette.bgHover,
  bgSelected: palette.bgSelected,
  bgHighlight: palette.bgHighlight,

  // canónicos del handoff (nuevos componentes)
  bright: palette.bright,
  text: palette.text,
  dim: palette.dim,
  mute: palette.mute,
  faint: palette.faint,
  ok: palette.ok,
  warn: palette.warn,
  err: palette.err,
};

export const icons = {
  check: "✓",
  cross: "✗",
  pending: "●",
  spinner: "⋯",
  arrow: "→",
  section: "─",
  focusBullet: "▎",
  dimBullet: " ",
  bullet: "·",
  diamond: "◆",
  brand: "◆",
  promptMark: "›",
  tabActiveLeft: "",
  tabActiveRight: "",
  tabSeparator: "  ",
  divider: "─",
  chevron: "›",
  star: "✦",
  plug: "◇",
  pkg: "◆",
  db: "▤",
  refresh: "↻",
  search: "⌕",
  cmd: "⌘",
  enter: "↵",
  up: "↑",
  down: "↓",
  tab: "⇥",
  esc: "⎋",
  play: "▸",
  stop: "■",
  install: "↓",
  uninstall: "×",
  clean: "⊘",
  legacy: "⚒",
  // NOTE: evitar el glyph "branch" U+2387. Varias fuentes de terminal (p. ej. la
  // default de Warp, en Mac y Windows) no lo incluyen y usan un fallback de ancho 2,
  // mientras Ink lo calcula como 1 → desalinea las columnas del tab Project (que lo
  // usa por fila). U+21B3 (bloque Arrows) está mucho mejor soportado y mide 1 celda.
  git: "↳",
  branch: "↳",
  commit: "●",
  edit: "✎",
  tool: "⚙",
  hook: "↪",
  test: "✓",
  todo: "□",
  clock: "◷",
  alertDot: "●",
  ring: "●",
  pin: "⌖",
  // canónicos del handoff
  focusBar: "▎",
  caret: "▍",
  expandCollapsed: "▸",
  expandExpanded: "▾",
  sectionDot: "·",
} as const;

export type ColorName = (typeof colors)[keyof typeof colors];

// ─── Accent configurable ────────────────────────────────────────────────────
// El accent es el único color de marca (focus, selección, bordes activos, brand
// glyph). `applyAccent` lo recolorea mutando `palette`/`colors` in-place: los 22
// archivos que importan `colors` siguen igual; el re-render lo dispara el
// `themeNonce` del shell (app.tsx). Default = violet (los literales de arriba).

export type AccentColor = "violet" | "cyan" | "green" | "yellow" | "red";

export const DEFAULT_ACCENT: AccentColor = "violet";

interface AccentDef {
  main: string; // acento principal
  soft: string; // hover / sub-acento
  selBg: string; // fondo de fila seleccionada (tinte oscuro del acento)
}

// Orden = orden de swatches en el tab Config.
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
 * Recolorea el theme in-place al accent dado. Idempotente. Tolera valores
 * inválidos (cae a violet). Llamar en boot (run.tsx) y on-change (Config tab).
 */
export function applyAccent(accent: AccentColor): void {
  const def = ACCENTS[accent] ?? ACCENTS[DEFAULT_ACCENT];
  currentAccent = ACCENTS[accent] ? accent : DEFAULT_ACCENT;

  palette.accent = def.main;
  palette.accentSoft = def.soft;
  palette.borderAccent = def.main;
  palette.purple = def.main;
  palette.purpleSoft = def.soft;
  palette.bgSelected = def.selBg;
  palette.bgHighlight = def.selBg;

  colors.primary = def.main;
  colors.accent = def.main;
  colors.accentSoft = def.soft;
  colors.secondary = def.soft;
  colors.purple = def.main;
  colors.borderActive = def.main;
  colors.bgSelected = def.selBg;
  colors.bgHighlight = def.selBg;
}
