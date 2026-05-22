import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import type { WarpPostInstallHint } from "../../../application/mcp-warp-postinstall-hint.js";
import {
  type SelfMcpConfigData,
  type SelfMcpConnectionView,
  selfMcpConfig,
} from "../../../application/self/mcp-config.js";
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

interface McpActionDef {
  id: "install-claude" | "install-codex" | "install-warp" | "doctor" | "remove" | "new";
  label: string;
  busyLabel: (name: string) => string;
  danger?: boolean;
}

const ACTIONS: readonly McpActionDef[] = [
  {
    id: "install-claude",
    label: "Instalar en Claude Code",
    busyLabel: () => "instalando en Claude…",
  },
  { id: "install-codex", label: "Instalar en Codex", busyLabel: () => "instalando en Codex…" },
  { id: "install-warp", label: "Instalar en Warp", busyLabel: () => "instalando en Warp…" },
  { id: "doctor", label: "Diagnosticar (doctor)", busyLabel: () => "diagnosticando…" },
  { id: "remove", label: "Eliminar conexión…", busyLabel: (n) => `eliminando ${n}…`, danger: true },
  { id: "new", label: "Nueva conexión…", busyLabel: () => "" },
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
 * MCPTab redesign — split view:
 *
 *  ┌─ conexiones ──────────────┐  ┌─ detalle (selected) ─┐
 *  │ › qtc-cert  DB_CERT_DSN   │  │ host visible en      │
 *  │   qtc-prod  DB_PROD_DSN   │  │ acciones: i/o/w/t/r  │
 *  └───────────────────────────┘  └──────────────────────┘
 *
 * - `↑↓` mueve cursor en la lista
 * - `n` nueva conexión, `r` eliminar la actual, `t` doctor
 * - `i/o/w` install en claude/codex/warp respectivamente
 * - Host chips reemplazan columnas Claude/Codex/Warp
 *
 * Mantiene los modos (new-name/new-dsn/confirm-delete/busy) tal cual; sólo
 * cambia el render de list y la forma de invocar acciones.
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
    // Lock global hotkeys solo en modes que toman input crítico (text inputs).
    if (mode.kind === "list" || mode.kind === "actions") unlock();
    else lock();
  }, [mode, lock, unlock]);

  useEffect(() => () => unlock(), [unlock]);

  const refresh = useCallback(async () => {
    try {
      const result = await selfMcpConfig(buildArgs("list"), ctx);
      const next = result.ok ? (result.data?.connections ?? []) : [];
      setConnections(next);
      setCursor((c) => Math.min(Math.max(0, next.length - 1), Math.max(0, c)));
    } catch (err) {
      onToast?.({ tone: "err", title: "Error cargando MCP", body: (err as Error).message });
    }
  }, [ctx, onToast]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void refresh();
  }, [refresh]);

  const current = connections[cursor];

  const runAction = useCallback(
    async (action: string, name: string, label: string) => {
      setMode({ kind: "busy", label });
      setWarpHint(null);
      try {
        const result: import("../../../domain/types.js").CommandResult<SelfMcpConfigData> =
          await selfMcpConfig(buildArgs(action, { name }), ctx);
        const summary = result.data?.summary ?? result.error?.message ?? "";
        const isWarpInstall = result.ok && action === "install-warp" && result.data?.warp_hint;
        onToast?.({
          tone: result.ok ? "ok" : "err",
          title: result.ok ? "Acción aplicada" : "Falló",
          body: summary,
        });
        if (isWarpInstall && result.data?.warp_hint) setWarpHint(result.data.warp_hint);
        await refresh();
      } catch (err) {
        onToast?.({ tone: "err", title: "Error", body: (err as Error).message });
      } finally {
        setMode({ kind: "list" });
      }
    },
    [ctx, refresh, onToast],
  );

  const applyAction = useCallback(
    (def: McpActionDef) => {
      if (def.id === "new") {
        setMode({ kind: "new-name" });
        return;
      }
      if (!current) return;
      if (def.id === "remove") {
        setMode({ kind: "confirm-delete", name: current.nombre });
        return;
      }
      void runAction(def.id, current.nombre, def.busyLabel(current.nombre));
    },
    [current, runAction],
  );

  // input — list mode (cursor en la lista de conexiones)
  useInput(
    (input, key) => {
      if (!isActive || mode.kind !== "list") return;
      if (handleNav(key, connections.length, setCursor)) return;
      if (input === "n" || input === "N") {
        setMode({ kind: "new-name" });
        return;
      }
      if (key.return) {
        setActionCursor(0);
        setMode({ kind: "actions" });
      }
    },
    { isActive },
  );

  // input — actions mode (cursor en las acciones del detail panel)
  useInput(
    (_input, key) => {
      if (!isActive || mode.kind !== "actions") return;
      if (key.upArrow) {
        setActionCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.downArrow) {
        setActionCursor((c) => Math.min(ACTIONS.length - 1, c + 1));
        return;
      }
      if (key.escape) {
        setMode({ kind: "list" });
        return;
      }
      if (key.return) {
        const def = ACTIONS[actionCursor];
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
        void runAction("remove", mode.name, `eliminando ${mode.name}…`);
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
          actionMode={mode.kind === "actions"}
          actionCursor={actionCursor}
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
                void runAction("use-env", mode.name, `registrando ${mode.name}…`);
                // NOTE: la acción `use-env` requiere también `dsn-var`; el helper
                // existente buildArgs sólo pasa `name`. Reusamos selfMcpConfig
                // directo aquí.
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

      {mode.kind === "list" ? (
        <Box marginTop={1}>
          <Text color={colors.fgFaint}>⏎ ver acciones · n nueva conexión · q salir</Text>
        </Box>
      ) : null}

      {mode.kind === "actions" ? (
        <Box marginTop={1}>
          <Text color={colors.fgFaint}>↑↓ navegar acciones · ⏎ aplicar · esc volver</Text>
        </Box>
      ) : null}
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
  actionMode,
  actionCursor,
}: {
  connections: SelfMcpConnectionView[];
  cursor: number;
  current: SelfMcpConnectionView | null;
  actionMode: boolean;
  actionCursor: number;
}) {
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
        {connections.length === 0 ? (
          <Text color={colors.fgFaint}>(ninguna registrada — `n` para crear)</Text>
        ) : (
          connections.map((c, i) => (
            <McpListRow key={c.nombre} conn={c} selected={i === cursor} dimmed={actionMode} />
          ))
        )}
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
        {current ? (
          <McpDetail conn={current} actionMode={actionMode} actionCursor={actionCursor} />
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
  // En actionMode (dimmed) la lista pierde foco — el cursor queda visible pero dim.
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

function McpDetail({
  conn,
  actionMode,
  actionCursor,
}: {
  conn: SelfMcpConnectionView;
  actionMode: boolean;
  actionCursor: number;
}) {
  const driftAny =
    conn.instalado.claude_code === "drift" ||
    conn.instalado.codex === "drift" ||
    conn.instalado.warp === "drift";
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={colors.fgBright} bold>
          {conn.nombre}
        </Text>
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
        <HostStatusLine id="claude" status={conn.instalado.claude_code} />
        <HostStatusLine id="codex" status={conn.instalado.codex} />
        <HostStatusLine id="warp" status={conn.instalado.warp} />
      </Box>
      <Box marginTop={1} flexDirection="column">
        {ACTIONS.map((a, i) => (
          <ActionRow
            key={a.id}
            label={a.label}
            danger={a.danger === true}
            active={actionMode && i === actionCursor}
          />
        ))}
      </Box>
    </Box>
  );
}

const MCP_HOST_LABELS: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  warp: "Warp Terminal",
};

function HostStatusLine({ id, status }: { id: string; status: "si" | "no" | "drift" }) {
  const label =
    status === "si" ? "instalado" : status === "drift" ? "drift de config" : "no instalado";
  const icon = status === "si" ? icons.check : status === "drift" ? "!" : icons.cross;
  const tone =
    status === "si" ? colors.success : status === "drift" ? colors.warning : colors.fgFaint;
  const hostLabel = MCP_HOST_LABELS[id] ?? id;
  return (
    <Box>
      <Text color={tone} bold>
        {icon}
      </Text>
      <Text> </Text>
      <Text color={status === "si" ? colors.fgBright : colors.fgSubtle}>{hostLabel}</Text>
      <Text color={colors.fgFaint}> · </Text>
      <Text color={tone}>{label}</Text>
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

function handleNav(
  key: { upArrow?: boolean; downArrow?: boolean },
  total: number,
  setCursor: (next: number | ((c: number) => number)) => void,
): boolean {
  if (key.upArrow) {
    setCursor((c) => Math.max(0, c - 1));
    return true;
  }
  if (key.downArrow) {
    setCursor((c) => (total === 0 ? 0 : Math.min(total - 1, c + 1)));
    return true;
  }
  return false;
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
