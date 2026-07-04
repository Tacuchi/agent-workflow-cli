import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

/**
 * NotificationCenter — unified global state for persistent banners (update
 * available, doctor check) and ephemeral messages (toasts).
 *
 * - Items with a `duration` auto-dismiss after `duration` ms (toasts).
 * - Items without one persist until `dismiss(id)` or the user's `x dismiss`.
 * - `push` is idempotent per `id`: re-pushing `update-available` replaces the
 *   existing item without duplicating.
 */

export type NotificationTone = "ok" | "info" | "warn" | "err";

export interface NotificationAction {
  /** Key that triggers the action (single char). */
  key: string;
  label: string;
  /** Highlights as the primary CTA (inverse bold). Defaults to the first one. */
  emphasis?: boolean;
  run: () => void;
}

export interface NotificationItem {
  id: string;
  tone: NotificationTone;
  title: string | ReactNode;
  body?: string;
  actions?: NotificationAction[];
  /** When set, auto-dismisses after `duration` ms. */
  duration?: number;
}

export interface NotificationInput {
  id?: string;
  tone?: NotificationTone;
  title: string | ReactNode;
  body?: string;
  actions?: NotificationAction[];
  duration?: number;
}

/** Legacy signature compatible with the old `useToasts.push`. */
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

/** Minimal structural sink so the provider can log without importing the Logger. */
export interface ErrorLogSink {
  error(message: string): unknown;
}

export interface NotificationCenterProviderProps {
  children: ReactNode;
  /**
   * Operational logger for the err-notification safety net: every err-toned item
   * pushed here is also written to the daily log (title + body). Optional so tests
   * and lightweight mounts can omit it.
   */
  logger?: ErrorLogSink;
}

export function NotificationCenterProvider({ children, logger }: NotificationCenterProviderProps) {
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

  // On unmount, clear every pending auto-dismiss timer so a timeout that fires
  // after teardown can't call `dismiss` (setItems) on an unmounted provider. The
  // timers Map outlives the render tree, so per-item cleanup alone isn't enough.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const handle of pending.values()) clearTimeout(handle);
      pending.clear();
    };
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
      };
      setItems((prev) => {
        const existingIdx = prev.findIndex((i) => i.id === id);
        if (existingIdx === -1) return [...prev, item];
        const next = prev.slice();
        next[existingIdx] = item;
        return next;
      });
      if (item.duration !== undefined) scheduleAutoDismiss(id, item.duration);
      // Safety net: mirror every err notification to the operational log so a
      // failure surfaced only as a fleeting toast still leaves a durable trace.
      // Only string titles are logged (ReactNode banners like the update card
      // carry no plain message). The Logger redacts secrets before writing.
      if (item.tone === "err" && typeof item.title === "string") {
        logger?.error(`tui: ${item.title}${item.body ? ` — ${item.body}` : ""}`);
      }
      return id;
    },
    [scheduleAutoDismiss, logger],
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
      // Top = newest item (last in the array).
      const top = prev[prev.length - 1];
      if (!top) return prev;
      clearTimer(top.id);
      didDismiss = true;
      return prev.slice(0, -1);
    });
    return didDismiss;
  }, [clearTimer]);

  const triggerAction = useCallback((key: string): boolean => {
    const normalized = key.toLowerCase();
    let actionRan = false;
    // Look up the action in the newest item first (LIFO).
    setItems((prev) => {
      for (let i = prev.length - 1; i >= 0; i--) {
        const item = prev[i];
        const match = item?.actions?.find((a) => a.key.toLowerCase() === normalized);
        if (match) {
          actionRan = true;
          // Run outside the setState callback to avoid side-effects in render.
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
