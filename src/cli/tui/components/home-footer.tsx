import { Box, Text } from "ink";
import { colors } from "../theme.js";
import type { KeymapEntry } from "./tabs-config.js";

export type HomeFooterContext = "palette" | "tab";

export interface HomeFooterProps {
  context: HomeFooterContext;
  /** Si true, inyecta `x dismiss` al footer para señalizar notifs activas. */
  showDismiss?: boolean;
}

const PALETTE_KEYS: KeymapEntry[] = [
  { key: "↑↓", action: "navigate" },
  { key: "⏎", action: "run" },
  { key: "esc", action: "close" },
  { key: "q", action: "quit" },
];

const TAB_KEYS: KeymapEntry[] = [
  { key: "^K", action: "palette" },
  { key: "tab", action: "next" },
  { key: "⇧tab", action: "prev" },
  { key: "q", action: "quit" },
];

const DISMISS_KEY: KeymapEntry = { key: "x", action: "dismiss" };

const DOT = "·";

export function HomeFooter({ context, showDismiss = false }: HomeFooterProps) {
  const baseKeys = context === "palette" ? PALETTE_KEYS : TAB_KEYS;
  const keys = showDismiss ? [DISMISS_KEY, ...baseKeys] : baseKeys;
  return (
    <Box marginTop={1}>
      <Text wrap="truncate-end">
        {keys.map((entry, idx) => (
          <Text key={`${entry.key}-${entry.action}`}>
            {idx > 0 ? (
              <Text color={colors.faint}>
                {"  "}
                {DOT}
                {"  "}
              </Text>
            ) : null}
            <Text color={colors.accent}>{entry.key}</Text>
            <Text color={colors.dim}> {entry.action}</Text>
          </Text>
        ))}
      </Text>
    </Box>
  );
}
