import { Box, Text } from "ink";
import { colors } from "../theme.js";

export interface KeymapEntry {
  key: string;
  action: string;
}

export interface KeymapBarProps {
  entries: KeymapEntry[];
}

export function KeymapBar({ entries }: KeymapBarProps) {
  return (
    <Box marginTop={1}>
      {entries.map((entry, idx) => (
        <Box key={`${entry.key}-${entry.action}`}>
          {idx > 0 ? <Text color={colors.fgMoreSubtle}> · </Text> : null}
          <Text color={colors.accent} bold>
            {entry.key}
          </Text>
          <Text color={colors.fgSubtle}> {entry.action}</Text>
        </Box>
      ))}
    </Box>
  );
}
