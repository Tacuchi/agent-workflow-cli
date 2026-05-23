import { Box, Text } from "ink";
import { useCallback, useRef, useState } from "react";
import { colors, icons } from "../theme.js";

export type ToastTone = "ok" | "info" | "err";

export interface ToastEntry {
  id: number;
  tone: ToastTone;
  title: string;
  body?: string;
  /** Duración en ms; default 3200 */
  duration?: number;
}

export interface ToastInput {
  tone?: ToastTone;
  title: string;
  body?: string;
  duration?: number;
}

/**
 * useToasts — hook que mantiene una pila de toasts y expone `push(toast)`.
 *
 * Auto-elimina cada toast después de `duration` (default 3.2s). El stack se
 * renderiza inline encima del footer cuando `toasts.length > 0`.
 */
export function useToasts() {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const seq = useRef(0);

  const push = useCallback((input: ToastInput) => {
    const id = ++seq.current;
    const tone = input.tone ?? "info";
    const duration = input.duration ?? 3200;
    const entry: ToastEntry = {
      id,
      tone,
      title: input.title,
      duration,
      ...(input.body !== undefined ? { body: input.body } : {}),
    };
    setToasts((prev) => [...prev, entry]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, duration);
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const clear = useCallback(() => {
    setToasts([]);
  }, []);

  return { toasts, push, dismiss, clear };
}

const TONE_COLOR: Record<ToastTone, string> = {
  ok: colors.success,
  info: colors.info,
  err: colors.error,
};

const TONE_ICON: Record<ToastTone, string> = {
  ok: icons.check,
  info: icons.bullet,
  err: icons.cross,
};

export interface ToastStackProps {
  toasts: ToastEntry[];
  /** Máximo de toasts visibles (los más nuevos arriba). Default 3. */
  max?: number;
}

/**
 * ToastStack — render inline de los toasts activos.
 *
 * En TTY no podemos posicionar absoluto, así que renderizamos al pie de la
 * pantalla (app.tsx coloca esto al final del root). Cada toast es una caja
 * con borde left del color del tone + título bold + body dim.
 */
export function ToastStack({ toasts, max = 3 }: ToastStackProps) {
  if (toasts.length === 0) return null;
  const visible = toasts.slice(-max);
  return (
    <Box flexDirection="column" marginTop={1}>
      {visible.map((t) => (
        <Box key={t.id} marginTop={0}>
          <Text color={TONE_COLOR[t.tone]} bold>
            {TONE_ICON[t.tone]}{" "}
          </Text>
          <Box flexDirection="column">
            <Text color={colors.fgBright} bold>
              {t.title}
            </Text>
            {t.body ? <Text color={colors.fgSubtle}>{t.body}</Text> : null}
          </Box>
        </Box>
      ))}
    </Box>
  );
}
