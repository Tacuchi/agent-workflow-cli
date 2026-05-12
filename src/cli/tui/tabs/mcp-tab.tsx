import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type SelfMcpConfigData,
  type SelfMcpConnectionView,
  selfMcpConfig,
} from "../../../application/self/mcp-config.js";
import type { CommandResult } from "../../../domain/types.js";
import type { ParsedArgs } from "../../parser.js";
import type { CliContext } from "../../types.js";
import { ConfirmModal } from "../components/confirm-modal.js";
import { ConnectionsGrid } from "../components/connections-grid.js";
import { InputPrompt } from "../components/input-prompt.js";
import {
  type MenuItem,
  type MenuItemTrailing,
  SectionedMenu,
} from "../components/sectioned-menu.js";
import { Toast, type ToastTone } from "../components/toast.js";
import { useInputLock } from "../input-lock.js";
import { type ColorName, colors, icons } from "../theme.js";

type Mode =
  | { kind: "list" }
  | { kind: "action-menu"; target: SelfMcpConnectionView }
  | { kind: "new-name" }
  | { kind: "new-dsn"; name: string }
  | { kind: "confirm-delete"; name: string }
  | { kind: "busy"; label: string };

type ConnectionAction = "install-claude" | "install-codex" | "install-warp" | "doctor" | "remove";

const ACTION_LABELS: Record<
  Exclude<ConnectionAction, "remove" | "doctor">,
  { label: string; busy: string }
> = {
  "install-claude": { label: "Instalar en Claude Code", busy: "instalando en Claude..." },
  "install-codex": { label: "Instalar en Codex", busy: "instalando en Codex..." },
  "install-warp": { label: "Instalar en Warp", busy: "instalando en Warp..." },
};

const STATUS_TRAILING: Record<"si" | "no" | "drift", MenuItemTrailing> = {
  si: { icon: icons.check, color: colors.success as ColorName, text: "instalado" },
  no: { icon: "–", color: colors.fgMoreSubtle as ColorName, text: "no instalado" },
  drift: { icon: "!", color: colors.warning as ColorName, text: "drift" },
};

export interface McpTabProps {
  ctx: CliContext;
  isActive: boolean;
}

function buildArgs(action: string, values: Record<string, string> = {}): ParsedArgs {
  return {
    rest: ["mcp", action],
    plugin: {},
    flags: new Set(),
    values: new Map(Object.entries(values)),
    valuesMulti: new Map(),
  };
}

function buildActionMenuItems(target: SelfMcpConnectionView): MenuItem<ConnectionAction>[] {
  return [
    {
      kind: "item",
      label: ACTION_LABELS["install-claude"].label,
      value: "install-claude",
      trailing: STATUS_TRAILING[target.instalado.claude_code],
    },
    {
      kind: "item",
      label: ACTION_LABELS["install-codex"].label,
      value: "install-codex",
      trailing: STATUS_TRAILING[target.instalado.codex],
    },
    {
      kind: "item",
      label: ACTION_LABELS["install-warp"].label,
      value: "install-warp",
      trailing: STATUS_TRAILING[target.instalado.warp],
    },
    { kind: "section" },
    { kind: "item", label: "Diagnosticar conexión", value: "doctor" },
    { kind: "item", label: "Eliminar conexión…", value: "remove" },
  ];
}

export function McpTab({ ctx, isActive }: McpTabProps) {
  const [connections, setConnections] = useState<SelfMcpConnectionView[]>([]);
  const [cursor, setCursor] = useState(0);
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const [toast, setToast] = useState<{ tone: ToastTone; message: string } | null>(null);
  const startedRef = useRef(false);
  const { lock, unlock } = useInputLock();

  // Lock global hotkeys (q/Tab/?/1-4) while a non-list mode owns the screen
  // (input prompt or confirm modal). Clear any prior toast so the previous
  // action result doesn't bleed into the new modal.
  useEffect(() => {
    if (mode.kind === "list") {
      unlock();
    } else {
      lock();
      setToast(null);
    }
  }, [mode, lock, unlock]);

  // Always release the lock when the tab unmounts.
  useEffect(() => {
    return () => unlock();
  }, [unlock]);

  const refresh = useCallback(async () => {
    try {
      const result = await selfMcpConfig(buildArgs("list"), ctx);
      const next = result.ok ? (result.data?.connections ?? []) : [];
      setConnections(next);
      setCursor((c) => Math.min(Math.max(0, next.length - 1), Math.max(0, c)));
    } catch (err) {
      setToast({ tone: "error", message: (err as Error).message });
    }
  }, [ctx]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void refresh();
  }, [refresh]);

  const runAction = useCallback(
    async (action: string, name: string, label: string) => {
      setMode({ kind: "busy", label });
      setToast(null);
      try {
        const result: CommandResult<SelfMcpConfigData> = await selfMcpConfig(
          buildArgs(action, { name }),
          ctx,
        );
        const summary = result.data?.summary ?? result.error?.message ?? "";
        setToast({ tone: result.ok ? "success" : "error", message: summary });
        await refresh();
      } catch (err) {
        setToast({ tone: "error", message: (err as Error).message });
      } finally {
        setMode({ kind: "list" });
      }
    },
    [ctx, refresh],
  );

  useInput(
    (input, key) => {
      if (!isActive || mode.kind !== "list") return;
      if (handleNavigation(input, key, connections.length, setCursor)) return;
      if (input === "n" || input === "N") {
        setMode({ kind: "new-name" });
        return;
      }
      if (key.return) {
        const target = connections[cursor];
        if (target) setMode({ kind: "action-menu", target });
      }
    },
    { isActive },
  );

  useInput(
    (input, key) => {
      if (!isActive) return;
      if (mode.kind !== "confirm-delete") return;
      if (input === "y" || input === "Y") {
        void runAction("remove", mode.name, `eliminando ${mode.name}...`);
      } else if (key.escape || input === "n" || input === "N") {
        setMode({ kind: "list" });
      }
    },
    { isActive },
  );

  // Esc cancela cualquier input mode (new-name / new-dsn / action-menu) y
  // vuelve a list. TextInput de @inkjs/ui no tiene onCancel propio, así que
  // registramos un useInput dedicado que coexiste con el del TextInput.
  useInput(
    (_, key) => {
      if (!isActive) return;
      if (mode.kind !== "new-name" && mode.kind !== "new-dsn" && mode.kind !== "action-menu") {
        return;
      }
      if (key.escape) {
        setMode({ kind: "list" });
      }
    },
    { isActive },
  );

  const handleActionSelect = useCallback(
    (action: ConnectionAction) => {
      if (mode.kind !== "action-menu") return;
      const name = mode.target.nombre;
      if (action === "remove") {
        setMode({ kind: "confirm-delete", name });
        return;
      }
      if (action === "doctor") {
        void runAction("doctor", name, "diagnosticando...");
        return;
      }
      const { busy } = ACTION_LABELS[action];
      void runAction(action, name, busy);
    },
    [mode, runAction],
  );

  // Render
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={colors.fg} bold>
          Conexiones MCP database
        </Text>
        <Text color={colors.fgMoreSubtle}> · </Text>
        <Text color={colors.fgSubtle}>
          {connections.length} registrada{connections.length === 1 ? "" : "s"}
        </Text>
      </Box>

      <Box marginTop={1}>
        {mode.kind === "list" ? (
          <ConnectionsGrid connections={connections} cursor={cursor} isActive={isActive} />
        ) : null}
        {mode.kind === "action-menu" ? (
          <Box flexDirection="column">
            <Text color={colors.fgSubtle}>
              {icons.bullet} acciones de{" "}
              <Text color={colors.fg} bold>
                {mode.target.nombre}
              </Text>
            </Text>
            <Box marginTop={1}>
              <SectionedMenu
                items={buildActionMenuItems(mode.target)}
                onSelect={handleActionSelect}
                isActive={isActive}
              />
            </Box>
            <Box marginTop={1}>
              <Text color={colors.fgMoreSubtle}>Esc para cerrar sin aplicar.</Text>
            </Box>
          </Box>
        ) : null}
        {mode.kind === "new-name" ? (
          <InputPrompt
            message="Nombre de la nueva conexión (slug-kebab):"
            onSubmit={(value) => {
              const trimmed = value.trim();
              if (!trimmed) {
                setToast({ tone: "error", message: "Nombre vacío." });
                setMode({ kind: "list" });
                return;
              }
              setMode({ kind: "new-dsn", name: trimmed });
            }}
            isActive={isActive}
          />
        ) : null}
        {mode.kind === "new-dsn" ? (
          <Box flexDirection="column">
            <Text color={colors.fgSubtle}>
              {icons.bullet} nombre:{" "}
              <Text color={colors.fg} bold>
                {mode.name}
              </Text>
            </Text>
            <Box marginTop={1}>
              <InputPrompt
                message="Variable de entorno con la DSN (UPPER_SNAKE_CASE):"
                onSubmit={(value) => {
                  const dsnVar = value.trim();
                  if (!dsnVar) {
                    setToast({ tone: "error", message: "DSN var vacía." });
                    setMode({ kind: "list" });
                    return;
                  }
                  void registerConnection(mode.name, dsnVar);
                }}
                isActive={isActive}
              />
            </Box>
          </Box>
        ) : null}
        {mode.kind === "confirm-delete" ? (
          <ConfirmModal
            tone="danger"
            title="Eliminar conexión"
            body={[
              `Vas a eliminar la conexión '${mode.name}'.`,
              "Esta acción no se puede deshacer.",
            ]}
            confirmKey="y"
            confirmLabel={`Sí, eliminar ${mode.name}`}
            cancelKey="n / Esc"
            cancelLabel="Cancelar"
          />
        ) : null}
        {mode.kind === "busy" ? (
          <Text color={colors.warning}>
            {icons.spinner} {mode.label}
          </Text>
        ) : null}
      </Box>

      {toast ? <Toast tone={toast.tone} message={toast.message} /> : null}
    </Box>
  );

  function handleNavigation(
    _input: string,
    key: { upArrow?: boolean; downArrow?: boolean },
    total: number,
    setCursorState: (next: number | ((c: number) => number)) => void,
  ): boolean {
    if (key.upArrow) {
      setCursorState((c) => Math.max(0, c - 1));
      return true;
    }
    if (key.downArrow) {
      setCursorState((c) => (total === 0 ? 0 : Math.min(total - 1, c + 1)));
      return true;
    }
    return false;
  }

  async function registerConnection(name: string, dsnVar: string) {
    setMode({ kind: "busy", label: `registrando ${name}...` });
    setToast(null);
    try {
      const result = await selfMcpConfig(buildArgs("use-env", { name, "dsn-var": dsnVar }), ctx);
      const summary = result.data?.summary ?? result.error?.message ?? "";
      setToast({ tone: result.ok ? "success" : "error", message: summary });
      await refresh();
    } catch (err) {
      setToast({ tone: "error", message: (err as Error).message });
    } finally {
      setMode({ kind: "list" });
    }
  }
}
