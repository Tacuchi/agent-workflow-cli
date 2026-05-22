import { Text } from "ink";
import { colors } from "../theme.js";

export type PillTone = "ok" | "warn" | "err" | "info" | "muted" | "accent";

export interface PillProps {
  tone?: PillTone;
  children: string;
  /** Si true, mantiene case del texto; default lo deja en lowercase. */
  preserveCase?: boolean;
}

/**
 * Pill — etiqueta corta tipo `[label]` con tono de color.
 *
 * Ink no permite `border-radius` ni `background-color` arbitrario en todos los
 * terminales — usamos paréntesis cuadrados y color de texto para señalizar el
 * tono. Mantiene la legibilidad y respeta la paleta sobria.
 */
export function Pill({ tone = "muted", children, preserveCase = false }: PillProps) {
  const color = TONE_COLOR[tone];
  const text = preserveCase ? children : children.toLowerCase();
  return (
    <Text color={color}>
      {"["}
      {text}
      {"]"}
    </Text>
  );
}

const TONE_COLOR: Record<PillTone, string> = {
  ok: colors.success,
  warn: colors.warning,
  err: colors.error,
  info: colors.info,
  muted: colors.fgMoreSubtle,
  accent: colors.accent,
};
