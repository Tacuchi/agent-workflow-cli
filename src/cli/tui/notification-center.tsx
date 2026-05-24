import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";

/**
 * NotificationCenter — estado global unificado para banners persistentes
 * (update available, doctor check) y mensajes efímeros (antes "toasts").
 *
 * - Items con `duration` definido se auto-dismiss tras `duration` ms (toasts).
 * - Items sin `duration` persisten hasta `dismiss(id)` o `x dismiss` del usuario.
 * - `push` es idempotente por `id`: re-pushear `update-available` reemplaza al
 *   item existente sin duplicar.
 */

export type NotificationTone = "ok" | "info" | "warn" | "err";

export interface NotificationAction {
  /** Tecla que dispara la acción (single char). */
  key: string;
  label: string;
  /** Resalta como CTA primaria (inverse bold). Por default la primera. */
  emphasis?: boolean;
  run: () => void;
}

export interface NotificationItem {
  id: string;
  tone: NotificationTone;
  title: string | ReactNode;
  body?: string;
  actions?: NotificationAction[];
  /** Si se define, auto-dismiss tras `duration` ms. */
  duration?: number;
  /** Default true. Cuando false oculta `x dismiss` y no responde a 'x'. */
  dismissible?: boolean;
}

export interface NotificationInput {
  id?: string;
  tone?: NotificationTone;
  title: string | ReactNode;
  body?: string;
  actions?: NotificationAction[];
  duration?: number;
  dismissible?: boolean;
}

/** Firma legacy compatible con el viejo `useToasts.push`. */
export interface ToastBridgeInput {
  tone?: "ok" | "info" | "err";
  title: string;
  body?: string;
  duration?: number;
}

interface NotificationCenterApi {
  items: NotificationItem[];
  push: (input: NotificationInput) => string;
  pushToast: (input: ToastBridgeInput) => string;
  dismiss: (id: string) => void;
  dismissTop: () => boolean;
  triggerAction: (key: string) => boolean;
}

const NotificationCenterContext = createContext<NotificationCenterApi | null>(null);

const DEFAULT_TOAST_DURATION_MS = 3200;

export interface NotificationCenterProviderProps {
  children: ReactNode;
}

export function NotificationCenterProvider({ children }: NotificationCenterProviderProps) {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const seq = useRef(0);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const clearTimer = useCallback((id: string) => {
    const t = timers.current.get(id);
    if (t) {
      clearTimeout(t);
      timers.current.delete(id);
    }
  }, []);

  const dismiss = useCallback(
    (id: string) => {
      clearTimer(id);
      setItems((prev) => prev.filter((i) => i.id !== id));
    },
    [clearTimer],
  );

  const scheduleAutoDismiss = useCallback(
    (id: string, duration: number) => {
      clearTimer(id);
      const handle = setTimeout(() => dismiss(id), duration);
      timers.current.set(id, handle);
    },
    [clearTimer, dismiss],
  );

  const push = useCallback(
    (input: NotificationInput): string => {
      const id = input.id ?? `n${++seq.current}`;
      const item: NotificationItem = {
        id,
        tone: input.tone ?? "info",
        title: input.title,
        ...(input.body !== undefined ? { body: input.body } : {}),
        ...(input.actions !== undefined ? { actions: input.actions } : {}),
        ...(input.duration !== undefined ? { duration: input.duration } : {}),
        ...(input.dismissible !== undefined ? { dismissible: input.dismissible } : {}),
      };
      setItems((prev) => {
        const existingIdx = prev.findIndex((i) => i.id === id);
        if (existingIdx === -1) return [...prev, item];
        const next = prev.slice();
        next[existingIdx] = item;
        return next;
      });
      if (item.duration !== undefined) scheduleAutoDismiss(id, item.duration);
      return id;
    },
    [scheduleAutoDismiss],
  );

  const pushToast = useCallback(
    (input: ToastBridgeInput): string => {
      const tone: NotificationTone =
        input.tone === "ok" ? "ok" : input.tone === "err" ? "err" : "info";
      return push({
        tone,
        title: input.title,
        ...(input.body !== undefined ? { body: input.body } : {}),
        duration: input.duration ?? DEFAULT_TOAST_DURATION_MS,
      });
    },
    [push],
  );

  const dismissTop = useCallback((): boolean => {
    let didDismiss = false;
    setItems((prev) => {
      // Top = el más nuevo y dismissible (último en el array).
      for (let i = prev.length - 1; i >= 0; i--) {
        const item = prev[i];
        if (item && item.dismissible !== false) {
          clearTimer(item.id);
          didDismiss = true;
          return prev.filter((_, idx) => idx !== i);
        }
      }
      return prev;
    });
    return didDismiss;
  }, [clearTimer]);

  const triggerAction = useCallback((key: string): boolean => {
    const normalized = key.toLowerCase();
    let actionRan = false;
    // Buscar la acción en el item más nuevo primero (LIFO).
    setItems((prev) => {
      for (let i = prev.length - 1; i >= 0; i--) {
        const item = prev[i];
        const match = item?.actions?.find((a) => a.key.toLowerCase() === normalized);
        if (match) {
          actionRan = true;
          // Ejecutar fuera del setState callback para evitar side-effects en render.
          queueMicrotask(() => match.run());
          break;
        }
      }
      return prev;
    });
    return actionRan;
  }, []);

  const api = useMemo<NotificationCenterApi>(
    () => ({ items, push, pushToast, dismiss, dismissTop, triggerAction }),
    [items, push, pushToast, dismiss, dismissTop, triggerAction],
  );

  return (
    <NotificationCenterContext.Provider value={api}>{children}</NotificationCenterContext.Provider>
  );
}

export function useNotifications(): NotificationCenterApi {
  const ctx = useContext(NotificationCenterContext);
  if (!ctx) {
    throw new Error("useNotifications must be used within a NotificationCenterProvider");
  }
  return ctx;
}
