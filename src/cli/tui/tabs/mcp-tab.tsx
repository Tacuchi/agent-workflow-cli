import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WarpPostInstallHint } from "../../../application/mcp-warp-postinstall-hint.js";
import {
  type SelfMcpConfigData,
  type SelfMcpConnectionView,
  selfMcpConfig,
} from "../../../application/self/mcp-config.js";
import type { CommandResult } from "../../../domain/types.js";
import type { ParsedArgs } from "../../parser.js";
import type { CliContext } from "../../types.js";
import { ActionModal, type ActionModalAction } from "../components/action-modal.js";
import { ConfirmModal } from "../components/confirm-modal.js";
import { FrameBox } from "../components/frame-box.js";
import { InputPrompt } from "../components/input-prompt.js";
import { ListRow } from "../components/list-row.js";
import { PageHead } from "../components/page-head.js";
import { useInputLock } from "../input-lock.js";
import { colors, icons } from "../theme.js";

type InstalledState = "installed" | "partial" | "missing";

type Mode =
  | { kind: "list" }
  | { kind: "actions" }
  | { kind: "wizard-name"; editingName?: string; prefillDsn?: string }
  | { kind: "wizard-dsn"; name: string; editingExisting?: string }
  | { kind: "confirm-delete"; name: string }
  | { kind: "busy"; label: string };

type ActionId = "test" | "install" | "edit" | "remove";

export interface McpTabProps {
  ctx: CliContext;
  isActive: boolean;
  onToast?: (msg: { tone: "ok" | "info" | "err"; title: string; body?: string }) => void;
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

/**
 * McpTab — listado MCP + ActionModal + Add wizard inline.
 *
 * Layout single-column:
 *   PageHead → action hint → FrameBox "connections" (ListRow per conn) →
 *   ActionModal (cuando mode='actions') | Wizard (cuando mode='wizard-*') |
 *   ConfirmModal (cuando mode='confirm-delete') | Busy banner.
 *
 * Acciones del modal (depende de installedState):
 *   - Test connection — corre `mcp doctor` (existing backend).
 *   - Install on hosts — encadena install-claude + install-codex + install-warp.
 *   - Edit — re-abre el wizard pre-rellenado para sobreescribir el DSN env var.
 *   - Remove (danger) — abre ConfirmModal y luego corre `mcp remove`.
 *
 * Atajos:
 *   - `a` (en list mode) → abre Add wizard.
 *   - ↑↓ + ⏎ navega y aplica.
 *   - Esc cierra modal/wizard.
 */
export function McpTab({ ctx, isActive, onToast }: McpTabProps) {
  const [connections, setConnections] = useState<SelfMcpConnectionView[]>([]);
  const [cursor, setCursor] = useState(0);
  const [actionCursor, setActionCursor] = useState(0);
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const [warpHint, setWarpHint] = useState<WarpPostInstallHint | null>(null);
  const startedRef = useRef(false);
  const { lock, unlock } = useInputLock();

  useEffect(() => {
    if (mode.kind === "list" || mode.kind === "actions") unlock();
    else lock();
  }, [mode, lock, unlock]);

  useEffect(() => () => unlock(), [unlock]);

  const refresh = useCallback(async () => {
    try {
      const result = await selfMcpConfig(buildArgs("list"), ctx);
      const next = result.ok ? (result.data?.connections ?? []) : [];
      setConnections(next);
      setCursor((c) => Math.min(Math.max(0, c), Math.max(0, next.length - 1)));
    } catch (err) {
      onToast?.({ tone: "err", title: "Error cargando MCP", body: (err as Error).message });
    }
  }, [ctx, onToast]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void refresh();
  }, [refresh]);

  const current = connections[cursor] ?? null;

  const installedState = useMemo<InstalledState>(() => {
    if (!current) return "missing";
    const states = [current.instalado.claude_code, current.instalado.codex, current.instalado.warp];
    const someInstalled = states.some((s) => s === "si");
    const allInstalled = states.every((s) => s === "si");
    if (allInstalled) return "installed";
    if (someInstalled) return "partial";
    return "missing";
  }, [current]);

  const driftAny = useMemo(() => {
    if (!current) return false;
    return (
      current.instalado.claude_code === "drift" ||
      current.instalado.codex === "drift" ||
      current.instalado.warp === "drift"
    );
  }, [current]);

  const runRawAction = useCallback(
    async (action: string, name: string, label: string): Promise<boolean> => {
      setMode({ kind: "busy", label });
      try {
        const result: CommandResult<SelfMcpConfigData> = await selfMcpConfig(
          buildArgs(action, { name }),
          ctx,
        );
        if (result.ok && action === "install-warp" && result.data?.warp_hint) {
          setWarpHint(result.data.warp_hint);
        }
        if (!result.ok) {
          const summary = result.error?.message ?? "fallo";
          onToast?.({ tone: "err", title: `Falló paso ${action}`, body: summary });
          return false;
        }
        return true;
      } catch (err) {
        onToast?.({ tone: "err", title: "Error", body: (err as Error).message });
        return false;
      }
    },
    [ctx, onToast],
  );

  const runInstallComposite = useCallback(
    async (name: string) => {
      setWarpHint(null);
      const steps: { action: string; label: string }[] = [
        { action: "install-claude", label: "instalando en Claude…" },
        { action: "install-codex", label: "instalando en Codex…" },
        { action: "install-warp", label: "instalando en Warp…" },
      ];
      for (const step of steps) {
        const ok = await runRawAction(step.action, name, step.label);
        if (!ok) {
          await refresh();
          setMode({ kind: "list" });
          return;
        }
      }
      onToast?.({
        tone: "ok",
        title: `Instalación OK · ${name}`,
        body: "claude + codex + warp",
      });
      await refresh();
      setMode({ kind: "list" });
    },
    [runRawAction, refresh, onToast],
  );

  const runDoctor = useCallback(
    async (name: string) => {
      const ok = await runRawAction("doctor", name, `pinging ${name}…`);
      if (ok) onToast?.({ tone: "ok", title: `Test OK · ${name}` });
      await refresh();
      setMode({ kind: "list" });
    },
    [runRawAction, refresh, onToast],
  );

  const applyModalAction = useCallback(
    (id: ActionId) => {
      if (!current) return;
      switch (id) {
        case "test":
          void runDoctor(current.nombre);
          return;
        case "install":
          void runInstallComposite(current.nombre);
          return;
        case "edit":
          setMode({
            kind: "wizard-name",
            editingName: current.nombre,
            prefillDsn: current.dsn_var,
          });
          return;
        case "remove":
          setMode({ kind: "confirm-delete", name: current.nombre });
          return;
      }
    },
    [current, runDoctor, runInstallComposite],
  );

  // Acciones del ActionModal — siempre las 4 disponibles cuando hay conexión.
  const modalActions: ActionModalAction[] = useMemo(() => {
    const installLabel =
      installedState === "installed"
        ? "Reinstall on hosts"
        : installedState === "partial"
          ? "Complete install"
          : "Install on hosts";
    return [
      {
        id: "test",
        icon: icons.refresh,
        label: "Test connection",
        desc: "Corre `mcp doctor` y reporta drift / hosts faltantes.",
      },
      {
        id: "install",
        icon: icons.install,
        label: installLabel,
        desc: "Encadena install-claude + install-codex + install-warp.",
        steps: ["install-claude", "install-codex", "install-warp"],
      },
      {
        id: "edit",
        icon: icons.edit,
        label: "Edit connection",
        desc: "Re-abre el wizard con la DSN env var pre-rellenada.",
      },
      {
        id: "remove",
        icon: icons.cross,
        label: "Remove connection",
        desc: "Quita la entrada del profile.json (no afecta el DSN).",
        danger: true,
      },
    ];
  }, [installedState]);

  // input — list mode
  useInput(
    (input, key) => {
      if (!isActive || mode.kind !== "list") return;
      if (input === "a" || input === "A") {
        setMode({ kind: "wizard-name" });
        return;
      }
      if (key.upArrow) {
        setCursor((c) => Math.max(0, c - 1));
        setActionCursor(0);
        return;
      }
      if (key.downArrow) {
        setCursor((c) => (connections.length === 0 ? 0 : Math.min(connections.length - 1, c + 1)));
        setActionCursor(0);
        return;
      }
      if (key.return && current) {
        setActionCursor(0);
        setMode({ kind: "actions" });
      }
    },
    { isActive },
  );

  // input — actions mode (modal)
  useInput(
    (_input, key) => {
      if (!isActive || mode.kind !== "actions") return;
      if (key.upArrow) {
        setActionCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.downArrow) {
        setActionCursor((c) => Math.min(modalActions.length - 1, c + 1));
        return;
      }
      if (key.escape) {
        setMode({ kind: "list" });
        return;
      }
      if (key.return) {
        const def = modalActions[actionCursor];
        if (def) applyModalAction(def.id as ActionId);
      }
    },
    { isActive },
  );

  // input — confirm-delete
  useInput(
    (input, key) => {
      if (!isActive || mode.kind !== "confirm-delete") return;
      if (input === "y" || input === "Y") {
        void runRawAction("remove", mode.name, `eliminando ${mode.name}…`).then(async (ok) => {
          if (ok) onToast?.({ tone: "ok", title: `Conexión '${mode.name}' eliminada` });
          await refresh();
          setMode({ kind: "list" });
        });
      } else if (key.escape || input === "n" || input === "N") {
        setMode({ kind: "list" });
      }
    },
    { isActive },
  );

  // input — esc en wizard
  useInput(
    (_input, key) => {
      if (!isActive) return;
      if (mode.kind === "wizard-name" || mode.kind === "wizard-dsn") {
        if (key.escape) setMode({ kind: "list" });
      }
    },
    { isActive },
  );

  return (
    <Box flexDirection="column">
      <PageHead title="MCP" count={{ label: `${connections.length} db`, tone: "info" }} />

      {mode.kind === "list" || mode.kind === "actions" ? (
        <>
          <Box marginBottom={1} flexDirection="row">
            <Text color={colors.accent} bold>
              a {icons.play} + add connection
            </Text>
            <Text color={colors.fgSubtle}> · ⏎ acciones · ↑↓ navegar</Text>
          </Box>

          <FrameBox
            title={`connections · ${connections.length}`}
            accent={connections.length > 0}
            dim={connections.length === 0}
          >
            {connections.length === 0 ? (
              <Box flexDirection="column">
                <Text color={colors.fgSubtle}>
                  Sin conexiones registradas todavía. Presioná <Text color={colors.accent}>a</Text>{" "}
                  para registrar la primera.
                </Text>
              </Box>
            ) : (
              connections.map((c, i) => {
                const cInstalled = [c.instalado.claude_code, c.instalado.codex, c.instalado.warp];
                const cAllInstalled = cInstalled.every((s) => s === "si");
                const cAnyInstalled = cInstalled.some((s) => s === "si");
                const cDrift = cInstalled.some((s) => s === "drift");
                const stateLabel = cAllInstalled
                  ? "installed"
                  : cAnyInstalled
                    ? "partial"
                    : "missing";
                const stateTone = cAllInstalled ? "ok" : cAnyInstalled ? "warn" : "dim";
                return (
                  <ListRow
                    key={c.nombre}
                    icon={icons.db}
                    iconActive={cAllInstalled}
                    title={c.nombre}
                    subtitle={`${c.server_name} · ${c.dsn_var}`}
                    meta={
                      cDrift
                        ? [{ label: "drift", tone: "warn" }]
                        : [{ label: "registered", tone: "ok" }]
                    }
                    state={{ label: stateLabel, tone: stateTone }}
                    chevron
                    active={i === cursor && mode.kind !== "actions"}
                  />
                );
              })
            )}
          </FrameBox>
        </>
      ) : null}

      {/* ActionModal (panel below list) */}
      {mode.kind === "actions" && current ? (
        <Box marginTop={1}>
          <ActionModal
            glyph={icons.db}
            title={current.nombre}
            subtitle={`${current.server_name} · ${current.dsn_var}`}
            state={{
              label:
                installedState === "installed"
                  ? "installed"
                  : installedState === "partial"
                    ? "partial"
                    : "missing",
              tone:
                installedState === "installed"
                  ? "ok"
                  : installedState === "partial"
                    ? "warn"
                    : "dim",
            }}
            actions={
              driftAny
                ? modalActions.map((a) =>
                    a.id === "test"
                      ? {
                          ...a,
                          hint: { tone: "warn", icon: icons.alertDot, text: "drift detectado" },
                        }
                      : a,
                  )
                : modalActions
            }
            cursor={actionCursor}
          />
        </Box>
      ) : null}

      {/* Wizard step 1 — alias / nombre */}
      {mode.kind === "wizard-name" ? (
        <Box marginTop={1} flexDirection="column">
          <FrameBox
            title={
              mode.editingName
                ? `edit MCP connection · ${mode.editingName}`
                : "register MCP connection"
            }
            accent
          >
            <Text color={colors.fgSubtle}>
              Paso 1/2 — alias de la conexión (slug-kebab).{" "}
              {mode.editingName ? `Actual: ${mode.editingName}` : ""}
            </Text>
            <Box marginTop={1}>
              <InputPrompt
                message="alias:"
                onSubmit={(value) => {
                  const trimmed = value.trim() || mode.editingName || "";
                  if (!trimmed) {
                    onToast?.({ tone: "err", title: "Alias vacío" });
                    setMode({ kind: "list" });
                    return;
                  }
                  setMode({
                    kind: "wizard-dsn",
                    name: trimmed,
                    ...(mode.editingName ? { editingExisting: mode.editingName } : {}),
                  });
                }}
                isActive={isActive}
              />
            </Box>
            <Text color={colors.fgSubtle}>Esc cancelar</Text>
          </FrameBox>
        </Box>
      ) : null}

      {/* Wizard step 2 — DSN env var + live JSON preview */}
      {mode.kind === "wizard-dsn" ? (
        <Box marginTop={1} flexDirection="column">
          <FrameBox title="register MCP connection · paso 2/2" accent>
            <Box>
              <Text color={colors.fgSubtle}>alias · </Text>
              <Text color={colors.fgBright} bold>
                {mode.name}
              </Text>
            </Box>
            <Box marginTop={1}>
              <InputPrompt
                message="DSN env var (UPPER_SNAKE_CASE):"
                onSubmit={(value) => {
                  const dsnVar = value.trim();
                  if (!dsnVar) {
                    onToast?.({ tone: "err", title: "DSN var vacía" });
                    setMode({ kind: "list" });
                    return;
                  }
                  void registerConnection(mode.name, dsnVar);
                }}
                isActive={isActive}
              />
            </Box>
            <Box marginTop={1} flexDirection="column">
              <Text color={colors.fgMoreSubtle}>PREVIEW · profile.json</Text>
              <Text color={colors.fgSubtle}>{"{"}</Text>
              <Text color={colors.fgSubtle}>{`  "mcp-servers": {`}</Text>
              <Text color={colors.fg}>{`    "${mode.name}": {`}</Text>
              <Text color={colors.fg}>{`      "env": "<DSN env var>",`}</Text>
              <Text color={colors.fg}>{`      "type": "stdio"`}</Text>
              <Text color={colors.fg}>{"    }"}</Text>
              <Text color={colors.fgSubtle}>{"  }"}</Text>
              <Text color={colors.fgSubtle}>{"}"}</Text>
            </Box>
            <Text color={colors.fgSubtle}>⏎ registrar · Esc cancelar</Text>
          </FrameBox>
        </Box>
      ) : null}

      {mode.kind === "confirm-delete" ? (
        <Box marginTop={1}>
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
        </Box>
      ) : null}

      {mode.kind === "busy" ? (
        <Box marginTop={1}>
          <Text color={colors.warning}>
            {icons.spinner} {mode.label}
          </Text>
        </Box>
      ) : null}

      {warpHint ? <WarpHintPanel hint={warpHint} /> : null}
    </Box>
  );

  async function registerConnection(name: string, dsnVar: string) {
    setMode({ kind: "busy", label: `registrando ${name}…` });
    try {
      const result = await selfMcpConfig(buildArgs("use-env", { name, "dsn-var": dsnVar }), ctx);
      const summary = result.data?.summary ?? result.error?.message ?? "";
      onToast?.({
        tone: result.ok ? "ok" : "err",
        title: result.ok ? "Conexión registrada" : "Falló",
        body: summary,
      });
      await refresh();
    } catch (err) {
      onToast?.({ tone: "err", title: "Error", body: (err as Error).message });
    } finally {
      setMode({ kind: "list" });
    }
  }
}

// ===== sub-components =====

function WarpHintPanel({ hint }: { hint: WarpPostInstallHint }) {
  const steps = hint.lines.slice(1);
  return (
    <Box
      marginTop={1}
      flexDirection="column"
      borderStyle="round"
      borderColor={colors.info}
      paddingX={1}
    >
      <Text color={colors.info} bold>
        {icons.bullet} Para que Warp lo spawnee:
      </Text>
      {steps.map((line, idx) => (
        <Text key={line} color={colors.fg}>
          {`  ${idx + 1}. ${line}`}
        </Text>
      ))}
      <Text color={colors.fgMoreSubtle}>Doc: {hint.doc_url}</Text>
    </Box>
  );
}
