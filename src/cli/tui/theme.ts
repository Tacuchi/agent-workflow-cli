// Paleta moderna azul/celeste inspirada en Tailwind sky/slate.
// Hex strings — Ink 5 acepta `Text color="#xxx"`.
//
// Convención:
// - `accent` / `accentSoft` — único acento (sky/cyan). Usar SOLO en lo activo.
// - `text-*` — 5 niveles (bright/normal/dim/mute/faint).
// - `border-*` — 4 niveles.
// - `bg-*` — 4 elevaciones + hover/selected.
// - Semánticos: `ok / warn / err / info`.

export const palette = {
  // surfaces — slate base con tinte azulado
  bg: "#0a0e1a",
  bgElev1: "#0f1729",
  bgElev2: "#152040",
  bgElev3: "#1e2a52",
  bgHover: "#1d2e5a",
  bgSelected: "#1e3a8a",

  // borders — slate
  borderFaint: "#1e293b",
  border: "#334155",
  borderStrong: "#475569",
  borderAccent: "#0284c7",

  // text — slate
  text: "#e2e8f0",
  textBright: "#f8fafc",
  textDim: "#94a3b8",
  textMute: "#64748b",
  textFaint: "#475569",

  // accent — sky (celeste moderno)
  accent: "#0ea5e9",
  accentSoft: "#38bdf8",

  // soportes
  purple: "#8b5cf6",
  purpleSoft: "#a78bfa",
  blue: "#3b82f6",
  cyan: "#06b6d4",
  green: "#10b981",
  greenDim: "#059669",
  yellow: "#f59e0b",
  orange: "#f97316",
  red: "#ef4444",

  // semánticos
  ok: "#10b981",
  warn: "#f59e0b",
  err: "#ef4444",
  info: "#06b6d4",
} as const;

// Map legacy `colors.*` names a hex de la paleta nueva.
export const colors = {
  primary: palette.accent,
  accent: palette.accent,
  accentSoft: palette.accentSoft,
  secondary: palette.accentSoft,

  success: palette.ok,
  warning: palette.warn,
  error: palette.err,
  info: palette.info,

  fg: palette.text,
  fgBright: palette.textBright,
  fgSubtle: palette.textDim,
  fgMoreSubtle: palette.textMute,
  fgFaint: palette.textFaint,

  border: palette.border,
  borderFaint: palette.borderFaint,
  borderStrong: palette.borderStrong,
  borderActive: palette.accent,

  bg: palette.bg,
  bgElev: palette.bgElev2,
  bgHover: palette.bgHover,
  bgSelected: palette.bgSelected,
} as const;

export const icons = {
  check: "✓",
  cross: "✗",
  pending: "●",
  spinner: "⋯",
  arrow: "→",
  section: "─",
  focusBullet: "❯",
  dimBullet: " ",
  bullet: "•",
  diamond: "◆",
  brand: "◆",
  promptMark: "›",
  tabActiveLeft: "[",
  tabActiveRight: "]",
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
  git: "⎇",
  branch: "⎇",
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
} as const;

export type ColorName = (typeof colors)[keyof typeof colors];
