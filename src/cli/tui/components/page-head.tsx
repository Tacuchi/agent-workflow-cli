import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { colors, toneColor } from "../theme.js";

export type PageHeadTone = "accent" | "ok" | "warn" | "err" | "dim" | "mute";

export interface PageHeadProps {
  /** Main title. */
  title: string;
  /** Counter / status inline next to the title — colored text, no brackets. */
  count?: { label: string; tone?: PageHeadTone };
  /** Descriptive inline subtitle · dim color. */
  desc?: string;
  /** Right-side meta or primary action. */
  action?: ReactNode;
  /** Compact: no bottom margin (consumed by internal sub-headers). */
  compact?: boolean;
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
          <Text color={toneColor(count.tone, colors.accent)} bold>
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
