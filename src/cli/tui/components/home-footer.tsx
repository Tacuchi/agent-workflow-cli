import { Box, Text } from "ink";
import { colors } from "../theme.js";
import type { KeymapEntry } from "./tabs-config.js";

export interface HomeFooterProps {
  /** Si true, inyecta `x dismiss` al footer para señalizar notifs activas. */
  showDismiss?: boolean;
}

const TAB_KEYS: KeymapEntry[] = [
  { key: "tab", action: "next" },
  { key: "⇧tab", action: "prev" },
  { key: "r", action: "refresh" },
  { key: "q", action: "quit" },
];

const DISMISS_KEY: KeymapEntry = { key: "x", action: "dismiss" };

const DOT = "·";

export function HomeFooter({ showDismiss = false }: HomeFooterProps) {
  const keys = showDismiss ? [DISMISS_KEY, ...TAB_KEYS] : TAB_KEYS;
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
