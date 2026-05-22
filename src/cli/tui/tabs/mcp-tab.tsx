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
import { ConfirmModal } from "../components/confirm-modal.js";
import { InputPrompt } from "../components/input-prompt.js";
import { PageHead } from "../components/page-head.js";
import { Pill } from "../components/pill.js";
import { useInputLock } from "../input-lock.js";
import { colors, icons } from "../theme.js";

type Mode =
  | { kind: "list" }
  | { kind: "actions" }
  | { kind: "new-name" }
  | { kind: "new-dsn"; name: string }
  | { kind: "confirm-delete"; name: string }
  | { kind: "busy"; label: string };

type CompositeAction = "install" | "reinstall" | "uninstall" | "doctor";

interface McpActionDef {
  id: CompositeAction;
  label: string;
  danger?: boolean;
  availableWhen: "missing" | "installed" | "always";
}

const ACTION_DEFS: readonly McpActionDef[] = [
  { id: "install", label: "Instalar", availableWhen: "missing" },
  { id: "reinstall", label: "Reinstalar", availableWhen: "installed" },
  { id: "doctor", label: "Diagnosticar (doctor)", availableWhen: "always" },
  { id: "uninstall", label: "Desinstalar", availableWhen: "installed", danger: true },
];

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
 * MCPTab — split view con sub-modes.
 *
 * Lista: connections reales + row "+ Nueva conexión" al final.
 * Detail: estado único (instalado/no instalado/parcial) + acciones composite.
 *
 * Modes:
 * - `list` — cursor en lista (connections + new-row). ↑↓ navega · ⏎ entra
 *   a `actions` (si conn) o a `new-name` (si new-row).
 * - `actions` — cursor en acciones contextuales del host activo. ↑↓ navega
 *   · ⏎ aplica · esc vuelve.
 *
 * Install composite: encadena install-claude + install-codex + install-warp.
 * Si alguno falla, aborta el resto y reporta.
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
      setCursor((c) => Math.min(Math.max(0, c), next.length));
    } catch (err) {
      onToast?.({ tone: "err", title: "Error cargando MCP", body: (err as Error).message });
    }
  }, [ctx, onToast]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void refresh();
  }, [refresh]);

  // cursor index >= connections.length → "Nueva conexión" row
  const isNewRow = cursor === connections.length;
  const current = isNewRow ? null : connections[cursor];

  const installedState = useMemo<"installed" | "partial" | "missing">(() => {
    if (!current) return "missing";
    const states = [current.instalado.claude_code, current.instalado.codex, current.instalado.warp];
    const someInstalled = states.some((s) => s === "si");
    const allInstalled = states.every((s) => s === "si");
    if (allInstalled) return "installed";
    if (someInstalled) return "partial";
    return "missing";
  }, [current]);

  const availableActions = useMemo(
    () =>
      ACTION_DEFS.filter((def) => {
        if (def.availableWhen === "always") return true;
        if (def.availableWhen === "missing") return installedState === "missing";
        return installedState !== "missing";
      }),
    [installedState],
  );

  const runRawAction = useCallback(
    async (action: string, name: string, label: string): Promise<boolean> => {
      setMode({ kind: "busy", label });
      try {
        const result: CommandResult<SelfMcpConfigData> = await selfMcpConfig(
          buildArgs(action, { name }),
          ctx,
        );
        const isWarpInstall = result.ok && action === "install-warp" && result.data?.warp_hint;
        if (isWarpInstall && result.data?.warp_hint) setWarpHint(result.data.warp_hint);
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

  const runComposite = useCallback(
    async (kind: CompositeAction, name: string) => {
      setWarpHint(null);
      if (kind === "doctor") {
        const ok = await runRawAction("doctor", name, `diagnosticando ${name}…`);
        if (ok) onToast?.({ tone: "ok", title: `Diagnóstico OK · ${name}` });
        await refresh();
        setMode({ kind: "list" });
        return;
      }
      if (kind === "uninstall") {
        const ok = await runRawAction("remove", name, `eliminando ${name}…`);
        if (ok) onToast?.({ tone: "ok", title: `Conexión '${name}' eliminada` });
        await refresh();
        setMode({ kind: "list" });
        return;
      }
      // install / reinstall — encadenar install-claude + install-codex + install-warp
      const steps: { action: string; label: string }[] = [
        {
          action: "install-claude",
          label: `${kind === "reinstall" ? "reinstalando" : "instalando"} en Claude…`,
        },
        {
          action: "install-codex",
          label: `${kind === "reinstall" ? "reinstalando" : "instalando"} en Codex…`,
        },
        {
          action: "install-warp",
          label: `${kind === "reinstall" ? "reinstalando" : "instalando"} en Warp…`,
        },
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
        title: `${kind === "reinstall" ? "Reinstalación" : "Instalación"} OK · ${name}`,
        body: "claude + codex + warp",
      });
      await refresh();
      setMode({ kind: "list" });
    },
    [runRawAction, refresh, onToast],
  );

  const applyAction = useCallback(
    (def: McpActionDef) => {
      if (!current) return;
      if (def.id === "uninstall") {
        setMode({ kind: "confirm-delete", name: current.nombre });
        return;
      }
      void runComposite(def.id, current.nombre);
    },
    [current, runComposite],
  );

  const totalListRows = connections.length + 1; // +1 = "Nueva conexión"

  // input — list mode (cursor en lista, incluye new-row)
  useInput(
    (_input, key) => {
      if (!isActive || mode.kind !== "list") return;
      if (key.upArrow) {
        setCursor((c) => Math.max(0, c - 1));
        setActionCursor(0);
        return;
      }
      if (key.downArrow) {
        setCursor((c) => Math.min(totalListRows - 1, c + 1));
        setActionCursor(0);
        return;
      }
      if (key.return) {
        if (isNewRow) {
          setMode({ kind: "new-name" });
        } else if (current) {
          setActionCursor(0);
          setMode({ kind: "actions" });
        }
      }
    },
    { isActive },
  );

  // input — actions mode (cursor en lista de acciones)
  useInput(
    (_input, key) => {
      if (!isActive || mode.kind !== "actions") return;
      if (key.upArrow) {
        setActionCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.downArrow) {
        setActionCursor((c) => Math.min(availableActions.length - 1, c + 1));
        return;
      }
      if (key.escape) {
        setMode({ kind: "list" });
        return;
      }
      if (key.return) {
        const def = availableActions[actionCursor];
        if (def) applyAction(def);
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

  // input — esc en new-name/new-dsn
  useInput(
    (_input, key) => {
      if (!isActive) return;
      if (mode.kind === "new-name" || mode.kind === "new-dsn") {
        if (key.escape) setMode({ kind: "list" });
      }
    },
    { isActive },
  );

  return (
    <Box flexDirection="column">
      <PageHead title="MCP" count={{ label: `${connections.length}`, tone: "info" }} />

      {mode.kind === "list" || mode.kind === "actions" ? (
        <McpSplitView
          connections={connections}
          cursor={cursor}
          current={current ?? null}
          installedState={installedState}
          actionMode={mode.kind === "actions"}
          actionCursor={actionCursor}
          availableActions={availableActions}
        />
      ) : null}

      {mode.kind === "new-name" ? (
        <InputPrompt
          message="Nombre de la nueva conexión (slug-kebab):"
          onSubmit={(value) => {
            const trimmed = value.trim();
            if (!trimmed) {
              onToast?.({ tone: "err", title: "Nombre vacío" });
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
          <Box>
            <Text color={colors.fgSubtle}>
              {icons.bullet} nombre:{" "}
              <Text color={colors.fgBright} bold>
                {mode.name}
              </Text>
            </Text>
          </Box>
          <Box marginTop={1}>
            <InputPrompt
              message="Variable de entorno con la DSN (UPPER_SNAKE_CASE):"
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
        </Box>
      ) : null}

      {mode.kind === "confirm-delete" ? (
        <ConfirmModal
          tone="danger"
          title="Eliminar conexión"
          body={[`Vas a eliminar la conexión '${mode.name}'.`, "Esta acción no se puede deshacer."]}
          confirmKey="y"
          confirmLabel={`Sí, eliminar ${mode.name}`}
          cancelKey="n / Esc"
          cancelLabel="Cancelar"
        />
      ) : null}

      {mode.kind === "busy" ? (
        <Box>
          <Text color={colors.warning}>
            {icons.spinner} {mode.label}
          </Text>
        </Box>
      ) : null}

      {warpHint ? <WarpHintPanel hint={warpHint} /> : null}

      <Box marginTop={1}>
        <Text color={colors.fgFaint}>
          {mode.kind === "actions"
            ? "↑↓ navegar acciones · ⏎ aplicar · esc volver"
            : "↑↓ navegar · ⏎ acciones / nueva"}
        </Text>
      </Box>
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

function McpSplitView({
  connections,
  cursor,
  current,
  installedState,
  actionMode,
  actionCursor,
  availableActions,
}: {
  connections: SelfMcpConnectionView[];
  cursor: number;
  current: SelfMcpConnectionView | null;
  installedState: "installed" | "partial" | "missing";
  actionMode: boolean;
  actionCursor: number;
  availableActions: readonly McpActionDef[];
}) {
  const isNewRow = cursor === connections.length;
  return (
    <Box>
      {/* lista */}
      <Box
        flexDirection="column"
        minWidth={42}
        marginRight={1}
        borderStyle="round"
        borderColor={actionMode ? colors.borderFaint : colors.borderActive}
        paddingX={1}
      >
        <Text color={colors.fgMoreSubtle}>CONEXIONES</Text>
        {connections.map((c, i) => (
          <McpListRow key={c.nombre} conn={c} selected={i === cursor} dimmed={actionMode} />
        ))}
        <NewConnectionRow selected={isNewRow} dimmed={actionMode} />
      </Box>

      {/* detalle */}
      <Box
        flexDirection="column"
        flexGrow={1}
        borderStyle="round"
        borderColor={actionMode ? colors.borderActive : colors.borderFaint}
        paddingX={1}
      >
        <Text color={colors.fgMoreSubtle}>DETALLE</Text>
        {isNewRow ? (
          <Box marginTop={1} flexDirection="column">
            <Text color={colors.fgBright} bold>
              Nueva conexión
            </Text>
            <Text color={colors.fgFaint}>
              ⏎ inicia el flujo de registro (nombre + DSN env var).
            </Text>
          </Box>
        ) : current ? (
          <McpDetail
            conn={current}
            installedState={installedState}
            actionMode={actionMode}
            actionCursor={actionCursor}
            availableActions={availableActions}
          />
        ) : (
          <Text color={colors.fgFaint}>(seleccioná una)</Text>
        )}
      </Box>
    </Box>
  );
}

function McpListRow({
  conn,
  selected,
  dimmed,
}: {
  conn: SelfMcpConnectionView;
  selected: boolean;
  dimmed: boolean;
}) {
  const focused = selected && !dimmed;
  const cursorColor = focused ? colors.accent : colors.fgFaint;
  const nameColor = dimmed ? colors.fgSubtle : focused ? colors.fgBright : colors.fgSubtle;
  return (
    <Box>
      <Text color={cursorColor} {...(focused ? { bold: true } : {})}>
        {selected ? "▸" : " "}
      </Text>
      <Text> </Text>
      <Box minWidth={14}>
        <Text color={nameColor} {...(focused ? { bold: true, inverse: true } : {})}>
          {focused ? ` ${conn.nombre} ` : conn.nombre}
        </Text>
      </Box>
      <Box>
        <Text color={colors.info}>{conn.dsn_var}</Text>
      </Box>
    </Box>
  );
}

function NewConnectionRow({ selected, dimmed }: { selected: boolean; dimmed: boolean }) {
  const focused = selected && !dimmed;
  const cursorColor = focused ? colors.accent : colors.fgFaint;
  const labelColor = focused ? colors.fgBright : colors.fgSubtle;
  const label = "+ Nueva conexión";
  return (
    <Box>
      <Text color={cursorColor} {...(focused ? { bold: true } : {})}>
        {selected ? "▸" : " "}
      </Text>
      <Text> </Text>
      <Text color={labelColor} {...(focused ? { bold: true, inverse: true } : {})}>
        {focused ? ` ${label} ` : label}
      </Text>
    </Box>
  );
}

function McpDetail({
  conn,
  installedState,
  actionMode,
  actionCursor,
  availableActions,
}: {
  conn: SelfMcpConnectionView;
  installedState: "installed" | "partial" | "missing";
  actionMode: boolean;
  actionCursor: number;
  availableActions: readonly McpActionDef[];
}) {
  const driftAny =
    conn.instalado.claude_code === "drift" ||
    conn.instalado.codex === "drift" ||
    conn.instalado.warp === "drift";
  const statePillTone =
    installedState === "installed" ? "ok" : installedState === "partial" ? "warn" : "muted";
  const stateLabel =
    installedState === "installed"
      ? "instalado"
      : installedState === "partial"
        ? "parcial"
        : "no instalado";
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={colors.fgBright} bold>
          {conn.nombre}
        </Text>
        <Box marginLeft={1}>
          <Pill tone={statePillTone}>{stateLabel}</Pill>
        </Box>
        {driftAny ? (
          <Box marginLeft={1}>
            <Pill tone="warn">drift</Pill>
          </Box>
        ) : null}
      </Box>
      <Text color={colors.fgMoreSubtle}>
        DSN env var · <Text color={colors.info}>{conn.dsn_var}</Text>
      </Text>
      <Text color={colors.fgMoreSubtle}>
        server name · <Text color={colors.info}>{conn.server_name}</Text>
      </Text>

      <Box marginTop={1} flexDirection="column">
        {availableActions.map((a, i) => (
          <ActionRow
            key={a.id}
            label={a.label}
            danger={a.danger === true}
            active={actionMode && i === actionCursor}
          />
        ))}
      </Box>
      <Text color={colors.fgFaint}>
        {installedState === "missing"
          ? "instalar encadena claude + codex + warp"
          : "reinstalar reaplica · desinstalar quita en todos los hosts"}
      </Text>
    </Box>
  );
}

function ActionRow({
  label,
  danger,
  active,
}: {
  label: string;
  danger: boolean;
  active: boolean;
}) {
  const cursorColor = active ? (danger ? colors.error : colors.accent) : colors.fgFaint;
  const labelColor = danger ? colors.error : active ? colors.fgBright : colors.fgSubtle;
  return (
    <Box>
      <Text color={cursorColor} {...(active ? { bold: true } : {})}>
        {active ? "▸" : " "}
      </Text>
      <Text> </Text>
      <Text color={labelColor} {...(active ? { bold: true, inverse: true } : {})}>
        {active ? ` ${label} ` : label}
      </Text>
    </Box>
  );
}

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
