import { Box } from "ink";
import type { ReactNode } from "react";
import { colors } from "../theme.js";

export interface ScreenFrameProps {
  children: ReactNode;
}

export function ScreenFrame({ children }: ScreenFrameProps) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={colors.border}
      paddingX={2}
      paddingY={1}
    >
      {children}
    </Box>
  );
}
