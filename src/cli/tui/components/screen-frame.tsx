import { Box } from "ink";
import type { ReactNode } from "react";
import { colors } from "../theme.js";
import { useTerminalSize } from "../use-terminal-size.js";

export interface ScreenFrameProps {
  children: ReactNode;
}

export function ScreenFrame({ children }: ScreenFrameProps) {
  // Acota el frame al alto del viewport. Junto con el alt-screen (run.tsx) y el
  // clip del contenido (app.tsx), evita que un tab alto (Workflow) empuje líneas
  // al scrollback y deje huérfanas al volver a un tab corto.
  //
  // Sólo acota con alto real de TTY (rows > 0). En no-TTY (pipes, tests) el alto
  // es desconocido: no hay viewport que acotar, así que se renderiza natural.
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
