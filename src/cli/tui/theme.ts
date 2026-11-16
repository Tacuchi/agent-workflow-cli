// Mono violet palette. Hex strings — Ink accepts `Text color="#xxx"`.
// `accent` marks focus and selection; five text levels; semantic ok/warn/err.
export const colors = {
  accent: "#a78bfa",
  bright: "#f4f1fc",
  text: "#d4d0e2",
  dim: "#9b94b8",
  mute: "#6e6588",
  faint: "#4a4368",
  ok: "#6ee7b7",
  warn: "#fbbf24",
  err: "#fb7185",
} as const;

export const icons = {
  check: "✓",
  cross: "✗",
  pending: "●",
  spinner: "⋯",
  arrow: "→",
  bullet: "·",
  focusBar: "▎",
} as const;
