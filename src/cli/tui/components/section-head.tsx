import { Box, Text } from "ink";
import { colors } from "../theme.js";

export interface SectionHeadProps {
  label: string;
  dotColor?: string;
  count?: number | string;
  hint?: string;
  rightAction?: string;
  marginTop?: number;
}

export function SectionHead({
  label,
  dotColor,
  count,
  hint,
  rightAction,
  marginTop = 0,
}: SectionHeadProps) {
  const dot = dotColor ?? colors.accent;
  return (
    <Box marginTop={marginTop}>
      <Text color={dot}>·</Text>
      <Text> </Text>
      <Text color={colors.mute}>{label.toUpperCase()}</Text>
      {count !== undefined && count !== "" ? (
        <>
          <Text> </Text>
          <Text color={colors.accent} bold>
            {String(count)}
          </Text>
        </>
      ) : null}
      {hint ? (
        <>
          <Text> </Text>
          <Text color={colors.dim}>{hint}</Text>
        </>
      ) : null}
      <Box flexGrow={1} />
      {rightAction ? <Text color={colors.mute}>{rightAction}</Text> : null}
    </Box>
  );
}
