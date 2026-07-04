import { Box } from "ink";
import type { ReactNode } from "react";
import { colors } from "../theme.js";
import { useTerminalSize } from "../use-terminal-size.js";

export interface ScreenFrameProps {
  children: ReactNode;
}

export function ScreenFrame({ children }: ScreenFrameProps) {
  // Bounds the frame to the viewport height. Together with the alt-screen
  // (run.tsx) and the content clip (app.tsx), it prevents a tall tab
  // (Workflow) from pushing lines into the scrollback and leaving orphans
  // when returning to a short tab.
  //
  // Only bounds with a real TTY height (rows > 0). On non-TTY (pipes, tests)
  // the height is unknown: no viewport to bound, so it renders naturally.
  const { rows } = useTerminalSize();
  const bounded = rows > 0;
  return (
    <Box
      flexDirection="column"
      borderStyle="bold"
      borderColor={colors.accent}
      paddingX={2}
      paddingY={1}
      height={bounded ? rows : undefined}
      overflowY={bounded ? "hidden" : "visible"}
    >
      {children}
    </Box>
  );
}
