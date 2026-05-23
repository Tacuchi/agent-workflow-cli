import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { colors } from "../theme.js";

export type PageHeadTone = "accent" | "ok" | "warn" | "err" | "dim" | "mute";

export interface PageHeadProps {
  /** Título principal */
  title: string;
  /** Counter / status inline next to title — texto coloreado sin brackets. */
  count?: { label: string; tone?: PageHeadTone };
  /** Subtítulo descriptivo inline · color dim. */
  desc?: string;
  /** Right-side meta o acción primaria. */
  action?: ReactNode;
  /** Compact: sin margin bottom (consumido por sub-headers internos). */
  compact?: boolean;
}

function toneColor(tone?: PageHeadTone): string {
  switch (tone) {
    case "accent":
      return colors.accent;
    case "ok":
      return colors.ok;
    case "warn":
      return colors.warn;
    case "err":
      return colors.err;
    case "dim":
      return colors.dim;
    case "mute":
      return colors.mute;
    default:
      return colors.accent;
  }
}

export function PageHead({ title, count, desc, action, compact = false }: PageHeadProps) {
  return (
    <Box marginBottom={compact ? 0 : 1} flexDirection="row">
      <Text color={colors.bright} bold>
        {title}
      </Text>
      {count ? (
        <>
          <Text> </Text>
          <Text color={toneColor(count.tone)} bold>
            {count.label}
          </Text>
        </>
      ) : null}
      {desc ? (
        <>
          <Text> </Text>
          <Text color={colors.dim}>{desc}</Text>
        </>
      ) : null}
      <Box flexGrow={1} />
      {action ? <Box>{action}</Box> : null}
    </Box>
  );
}
