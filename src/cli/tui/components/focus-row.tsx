import { Text } from "ink";
import type { ReactNode } from "react";
import { colors, icons } from "../theme.js";

// Overhead aproximado del chrome (ScreenFrame + content box: bordes + paddings)
// para que el bg highlight llene el ancho de la fila sin pasarse del borde.
const FRAME_OVERHEAD = 12;
const DEFAULT_LABEL_WIDTH = 16;

export interface FocusRowProps {
  /** Enfocada → barra de color al inicio + fondo highlight full-width. */
  focused: boolean;
  /** Ancho de terminal. El contenedor lo provee (un solo `useTerminalSize`). */
  cols: number;
  label: string;
  labelColor?: string | undefined;
  /** Columnas que ocupan los `children` — dimensiona el spacer del fondo. */
  valueWidth: number;
  labelWidth?: number;
  children: ReactNode;
}

/**
 * Fila enfocable con barra de focus + resaltado de fondo full-width, alineada
 * con las listas de MCP/Skills (`list-row`) y el Workflow (`family-card`).
 *
 * La barra va AFUERA del fondo (como list-row). Todo el contenido vive en una
 * sola `Text` con `wrap="truncate-end"` (las `Text` anidadas heredan el
 * `backgroundColor`) y un spacer que llena el ancho restante. Esa estructura de
 * una sola `Text` evita que un spacer ancho dentro de una `Box`-row se trague la
 * barra (bug observado en la primera versión).
 */
export function FocusRow({
  focused,
  cols,
  label,
  labelColor,
  valueWidth,
  labelWidth = DEFAULT_LABEL_WIDTH,
  children,
}: FocusRowProps) {
  const bgProp = focused ? { backgroundColor: colors.bgHighlight } : {};
  // Ancho ya usado dentro de la fila: barra(1) + gap(1) + innerpad(1) + label + value.
  const spacerLen = Math.max(1, cols - FRAME_OVERHEAD - 3 - labelWidth - valueWidth);
  return (
    <Text wrap="truncate-end">
      <Text color={focused ? colors.accent : colors.faint} bold={focused}>
        {focused ? icons.focusBar : " "}
      </Text>
      <Text> </Text>
      <Text {...bgProp}>
        {" "}
        <Text color={labelColor ?? (focused ? colors.bright : colors.text)} bold={focused}>
          {label.padEnd(labelWidth)}
        </Text>
        {children}
        {" ".repeat(spacerLen)}
      </Text>
    </Text>
  );
}
