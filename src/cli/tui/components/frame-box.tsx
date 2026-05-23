import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { colors } from "../theme.js";

export interface FrameBoxProps {
  title?: string;
  accent?: boolean;
  dim?: boolean;
  children: ReactNode;
  marginBottom?: number;
}

export function FrameBox({
  title,
  accent = false,
  dim = false,
  children,
  marginBottom = 1,
}: FrameBoxProps) {
  const borderColor = accent ? colors.borderActive : dim ? colors.borderFaint : colors.border;
  const titleColor = accent ? colors.accent : colors.fgMoreSubtle;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={borderColor}
      paddingX={1}
      marginBottom={marginBottom}
    >
      {title ? <Text color={titleColor}>{title.toUpperCase()}</Text> : null}
      <Box flexDirection="column">{children}</Box>
    </Box>
  );
}
