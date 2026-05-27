// Dimensiones de la terminal (filas/columnas) con re-render en `resize`.
//
// Ink expone `useStdout()` pero no re-renderiza al cambiar el tamaño de la
// terminal. Este hook se suscribe al evento `resize` del stdout y fuerza el
// re-render para que el frame se mantenga acotado al viewport (ver ScreenFrame).

import { useStdout } from "ink";
import { useEffect, useState } from "react";

export interface TerminalSize {
  // `0` = alto desconocido (stdout no-TTY: pipes, CI, ink-testing-library).
  // El consumidor NO debe acotar en ese caso (no hay viewport real que acotar).
  rows: number;
  // Fallback 80: sólo se usa para truncar ancho de texto, inocuo si es estimado.
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
    // Re-sincroniza por si el tamaño cambió entre el primer render y el effect.
    onResize();
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  return size;
}
