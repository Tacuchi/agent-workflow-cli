// Paleta + iconos compartidos por la TUI. Inspirado (no copiado) en
// charmbracelet/crush + charmtone: jerarquía fg en 4 niveles, accent claro
// distinto al primary, iconografía minimal Unicode (compatible con cualquier
// terminal moderna sin emojis).

export const colors = {
  primary: "magenta",
  accent: "cyan",
  secondary: "magentaBright",
  success: "green",
  warning: "yellow",
  error: "red",
  info: "blue",
  fg: "white",
  fgSubtle: "gray",
  fgMoreSubtle: "blackBright",
  border: "blackBright",
  borderActive: "magenta",
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
} as const;

export type ColorName = (typeof colors)[keyof typeof colors];
