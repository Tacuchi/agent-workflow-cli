import { Text } from "ink";
import type { ReactNode } from "react";
import { colors, icons } from "../theme.js";

// Approximate chrome overhead (ScreenFrame + content box: borders + paddings)
// so the bg highlight fills the row width without spilling past the border.
const FRAME_OVERHEAD = 12;
const DEFAULT_LABEL_WIDTH = 16;

export interface FocusRowProps {
  /** Focused → colored bar at the start + full-width highlight background. */
  focused: boolean;
  /** Terminal width. Provided by the container (a single `useTerminalSize`). */
  cols: number;
  label: string;
  labelColor?: string | undefined;
  /** Columns the `children` occupy — sizes the background spacer. */
  valueWidth: number;
  labelWidth?: number;
  children: ReactNode;
}

/**
 * Focusable row with a focus bar + full-width background highlight, aligned
 * with the MCP/Skills/Workline lists (`list-row`).
 *
 * The bar sits OUTSIDE the background (like list-row). All content lives in a
 * single `Text` with `wrap="truncate-end"` (nested `Text` inherit the
 * `backgroundColor`) plus a spacer that fills the remaining width. That
 * single-`Text` structure prevents a wide spacer inside a `Box`-row from
 * swallowing the bar.
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
  // Width already used inside the row: bar(1) + gap(1) + innerpad(1) + label + value.
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
