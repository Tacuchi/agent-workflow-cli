import { Box, Text } from "ink";
import { colors } from "../theme.js";
import type { KeymapEntry } from "./tabs-config.js";

export type HomeFooterContext = "palette" | "tab";

export interface HomeFooterProps {
  context: HomeFooterContext;
}

const PALETTE_KEYS: KeymapEntry[] = [
  { key: "↑↓", action: "navigate" },
  { key: "⏎", action: "run" },
  { key: "esc", action: "clear/back" },
  { key: "?", action: "help" },
  { key: "q", action: "quit" },
];

const TAB_KEYS: KeymapEntry[] = [
  { key: "^K", action: "home" },
  { key: "1-5", action: "tabs" },
  { key: "?", action: "help" },
  { key: "q", action: "quit" },
];

const DOT = "·";

export function HomeFooter({ context }: HomeFooterProps) {
  const keys = context === "palette" ? PALETTE_KEYS : TAB_KEYS;
  return (
    <Box>
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
