import { Box, Text } from "ink";
import { colors } from "../theme.js";

export interface SectionHeadProps {
  label: string;
  count?: number | string;
  hint?: string;
  rightAction?: string;
}

export function SectionHead({ label, count, hint, rightAction }: SectionHeadProps) {
  return (
    <Box>
      <Text color={colors.accent}>·</Text>
      <Text color={colors.mute}> {label.toUpperCase()}</Text>
      {count !== undefined && count !== "" ? (
        <Text color={colors.accent} bold>
          {" "}
          {String(count)}
        </Text>
      ) : null}
      {hint ? <Text color={colors.dim}> {hint}</Text> : null}
      <Box flexGrow={1} />
      {rightAction ? <Text color={colors.mute}>{rightAction}</Text> : null}
    </Box>
  );
}
