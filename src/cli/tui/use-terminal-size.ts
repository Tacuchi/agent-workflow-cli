// Terminal dimensions (rows/columns) with re-render on `resize`.
//
// Ink exposes `useStdout()` but does not re-render when the terminal size
// changes. This hook subscribes to stdout's `resize` event and forces the
// re-render so the frame stays bounded to the viewport (see ScreenFrame).

import { useStdout } from "ink";
import { useEffect, useState } from "react";

export interface TerminalSize {
  // `0` = unknown height (non-TTY stdout: pipes, CI, ink-testing-library).
  // Consumers must NOT clamp in that case (there is no real viewport to clamp to).
  rows: number;
  // Fallback 80: only used to truncate text width, harmless when estimated.
  cols: number;
}

const FALLBACK_COLS = 80;

export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();

  const [size, setSize] = useState<TerminalSize>(() => ({
    rows: stdout?.rows ?? 0,
    cols: stdout?.columns ?? FALLBACK_COLS,
  }));

  useEffect(() => {
    if (!stdout) return;
    const onResize = () => {
      setSize({ rows: stdout.rows ?? 0, cols: stdout.columns ?? FALLBACK_COLS });
    };
    stdout.on("resize", onResize);
    // Re-sync in case the size changed between the first render and the effect.
    onResize();
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  return size;
}
