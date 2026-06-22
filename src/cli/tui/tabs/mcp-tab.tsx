import { Box, Text, useInput, useStdout } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import { testMcpConnection } from "../../../application/mcp-test-connection-service.js";
import {
  type SelfMcpConfigData,
  type SelfMcpConnectionView,
  selfMcpConfig,
} from "../../../application/self/mcp-config.js";
import type { CommandResult } from "../../../domain/types.js";
import type { ParsedArgs } from "../../parser.js";
import type { CliContext } from "../../types.js";
import { type ActivityEvent, ActivityFeed } from "../components/activity-feed.js";
import { ConfirmBanner } from "../components/confirm-banner.js";
import { type DetailAction, DetailPanel } from "../components/detail-panel.js";
import { InputPrompt } from "../components/input-prompt.js";
import { ListRow } from "../components/list-row.js";
import { PageHead } from "../components/page-head.js";
import { QuickActions } from "../components/quick-actions.js";
import { SectionHead } from "../components/section-head.js";
import { useInputLock } from "../input-lock.js";
import { rowWidth } from "../row-width.js";
import { colors, icons } from "../theme.js";

type Mode =
  | { kind: "list" }
  | { kind: "detail" }
  | { kind: "wizard-name"; editingName?: string; prefillDsn?: string }
  | { kind: "wizard-dsn"; name: string; editingExisting?: string }
  | { kind: "confirm-delete"; name: string }
  | { kind: "busy"; label: string };

type ActionId = "test" | "edit" | "remove";

export interface McpTabProps {
  ctx: CliContext;
  isActive: boolean;
  onToast?: (msg: { tone: "ok" | "info" | "err"; title: string; body?: string }) => void;
  recentEvents?: ActivityEvent[];
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

export function McpTab({ ctx, isActive, onToast, recentEvents }: McpTabProps) {
  const [connections, setConnections] = useState<SelfMcpConnectionView[]>([]);
  const [cursor, setCursor] = useState(0);
  const [actionCursor, setActionCursor] = useState(0);
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const startedRef = useRef(false);
  const { lock, unlock } = useInputLock();
  const { stdout } = useStdout();

  useEffect(() => {
    if (mode.kind === "list" || mode.kind === "detail") unlock();
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
      onToast?.({ tone: "err", title: "Error loading MCP", body: (err as Error).message });
    }
  }, [ctx, onToast]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void refresh();
  }, [refresh]);

  const current = connections[cursor] ?? null;

  const runRawAction = useCallback(
    async (action: string, name: string, label: string): Promise<boolean> => {
      setMode({ kind: "busy", label });
      try {
        const result: CommandResult<SelfMcpConfigData> = await selfMcpConfig(
          buildArgs(action, { name }),
          ctx,
        );
        if (!result.ok) {
          const summary = result.error?.message ?? "failed";
          onToast?.({ tone: "err", title: `Step ${action} failed`, body: summary });
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

  /**
   * Test connection — ejecuta `npx -y @bytebase/dbhub` con el DSN resuelto.
   * Si dbhub arranca sin errores fatales en menos de 5s, asumimos que la
   * conexión al motor de datos está OK. Si dbhub falla rápidamente (DSN
   * inválido, host inalcanzable, credenciales malas), reportamos el stderr.
   */
  const runTestConnection = useCallback(
    async (name: string, dsnVar: string) => {
      setMode({ kind: "busy", label: `testing ${name} → dbhub…` });
      try {
        const result = await testMcpConnection({
          dsnVar,
          env: process.env,
          paths: ctx.paths,
          platform: process.platform,
        });
        if (result.ok) {
          onToast?.({
            tone: "ok",
            title: `Connection OK · ${name}`,
            body: `dbhub conectó usando ${dsnVar} (${result.source ?? "unknown"})`,
          });
        } else {
          onToast?.({
            tone: "err",
            title: `Test failed · ${name}`,
            body: result.error ?? "dbhub no pudo conectar",
          });
        }
      } catch (err) {
        onToast?.({ tone: "err", title: "Test failed", body: (err as Error).message });
      }
      await refresh();
      setMode({ kind: "list" });
    },
    [ctx, onToast, refresh],
  );

  const triggerAction = useCallback(
    (id: ActionId) => {
      if (!current) return;
      switch (id) {
        case "test":
          void runTestConnection(current.nombre, current.dsn_var);
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
    [current, runTestConnection],
  );

  // Detail panel actions (Test/Edit/Remove).
  const detailActions: DetailAction[] = current
    ? [
        { name: "Test connection", description: "Run dbhub with DSN (SELECT 1 smoke test)." },
        { name: "Edit connection", description: "Alias / host / DSN." },
        {
          name: "Remove connection",
          description: "Delete entry + DSN export.",
          danger: true,
        },
      ]
    : [];

  // input — list mode (↑↓ navega · ⏎ abre detail · 'a' add wizard)
  useInput(
    (input, key) => {
      if (!isActive || mode.kind !== "list") return;
      if (input === "a" || input === "A") {
        setMode({ kind: "wizard-name" });
        return;
      }
      if (key.upArrow) {
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.downArrow) {
        setCursor((c) => (connections.length === 0 ? 0 : Math.min(connections.length - 1, c + 1)));
        return;
      }
      if (key.return && current) {
        setActionCursor(0);
        setMode({ kind: "detail" });
      }
    },
    { isActive },
  );

  // input — detail mode (↑↓ navega actions · ⏎ ejecuta focused · Esc cierra)
  useInput(
    (_input, key) => {
      if (!isActive || mode.kind !== "detail" || !current) return;
      if (key.upArrow) {
        setActionCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.downArrow) {
        setActionCursor((c) => Math.min(detailActions.length - 1, c + 1));
        return;
      }
      if (key.escape) {
        setMode({ kind: "list" });
        return;
      }
      if (key.return) {
        const action = detailActions[actionCursor];
        if (!action) return;
        if (action.danger) {
          triggerAction("remove");
        } else if (action.name.startsWith("Edit")) {
          triggerAction("edit");
        } else {
          triggerAction("test");
        }
      }
    },
    { isActive },
  );

  // input — confirm-delete (y confirma · n/esc vuelve al detail)
  useInput(
    (input, key) => {
      if (!isActive || mode.kind !== "confirm-delete") return;
      if (input === "y" || input === "Y") {
        void runRawAction("remove", mode.name, `removing ${mode.name}…`).then(async (ok) => {
          if (ok) onToast?.({ tone: "ok", title: `Connection '${mode.name}' removed` });
          await refresh();
          setMode({ kind: "list" });
        });
      } else if (key.escape || input === "n" || input === "N") {
        setMode({ kind: "detail" });
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
      <PageHead
        title="MCP"
        count={{ label: `${connections.length} databases · profile.json`, tone: "accent" }}
        action={<Text color={colors.mute}>aliases match mcp_databases[] · consumed by skills</Text>}
      />

      {/* with-detail layout */}
      <Box flexDirection="row">
        {/* Left: list */}
        <Box flexDirection="column" flexGrow={1} paddingRight={2}>
          <SectionHead
            label="Connections"
            count={connections.length}
            {...(mode.kind === "wizard-name" || mode.kind === "wizard-dsn"
              ? { rightAction: "esc cancel" }
              : mode.kind === "detail" || mode.kind === "confirm-delete"
                ? { rightAction: "esc to close detail" }
                : {})}
          />

          {connections.length === 0 && mode.kind === "list" ? (
            <Box marginLeft={2} marginTop={1} flexDirection="column">
              <Text color={colors.dim}>No MCP connections yet.</Text>
              <Text color={colors.dim}>
                Register a DSN to let skills query your DB. Press{" "}
                <Text color={colors.accent} bold>
                  a
                </Text>{" "}
                to start.
              </Text>
            </Box>
          ) : (
            <Box marginTop={0} flexDirection="column">
              {connections.map((c, i) => (
                <ListRow
                  key={c.nombre}
                  icon={icons.diamond}
                  iconActive={true}
                  title={c.nombre}
                  subtitle={`${c.dsn_var} · ${c.server_name}`}
                  state={{ label: "registered", tone: "ok" }}
                  chevron
                  active={i === cursor}
                  dimmed={mode.kind === "wizard-name" || mode.kind === "wizard-dsn"}
                  widthHint={rowWidth(
                    stdout?.columns,
                    mode.kind === "detail" ||
                      mode.kind === "confirm-delete" ||
                      mode.kind === "wizard-name" ||
                      mode.kind === "wizard-dsn",
                  )}
                />
              ))}
            </Box>
          )}

          {/* Wizard inline — solo SectionHead + InputPrompt limpio (sin
              duplicación con un decorative input box). */}
          {mode.kind === "wizard-name" ? (
            <Box flexDirection="column" marginTop={1}>
              <SectionHead
                label={
                  mode.editingName
                    ? `Edit connection · ${mode.editingName}`
                    : "Register new connection"
                }
                hint="Step 1 of 2 · Alias"
                rightAction="⏎ next · esc cancel"
              />
              <Box marginLeft={2} marginTop={0}>
                <InputPrompt
                  message="alias (slug-kebab):"
                  onSubmit={(value) => {
                    const trimmed = value.trim() || mode.editingName || "";
                    if (!trimmed) {
                      onToast?.({ tone: "err", title: "Empty alias" });
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
            </Box>
          ) : null}
          {mode.kind === "wizard-dsn" ? (
            <Box flexDirection="column" marginTop={1}>
              <SectionHead
                label={`Register new connection · ${mode.name}`}
                hint="Step 2 of 2 · DSN env var"
                rightAction="⏎ register · esc cancel"
              />
              <Box marginLeft={2} marginTop={0}>
                <InputPrompt
                  message="DSN env var (UPPER_SNAKE_CASE):"
                  onSubmit={(value) => {
                    const dsnVar = value.trim();
                    if (!dsnVar) {
                      onToast?.({ tone: "err", title: "Empty DSN var" });
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

          {/* Recent calls */}
          {mode.kind === "list" ? (
            <>
              <SectionHead label="Recent" count={recentEvents?.length ?? 0} marginTop={1} />
              <Box marginLeft={2}>
                <ActivityFeed
                  events={recentEvents ?? []}
                  cap={4}
                  emptyHint="  (no recent MCP calls yet)"
                />
              </Box>
            </>
          ) : null}

          {mode.kind === "busy" ? (
            <Box marginTop={1}>
              <Text color={colors.warn}>
                {icons.spinner} {mode.label}
              </Text>
            </Box>
          ) : null}
        </Box>

        {/* Right: detail panel (sólo cuando se seleccionó un row con Enter) */}
        {current && (mode.kind === "detail" || mode.kind === "confirm-delete") ? (
          <DetailPanel
            bordered
            header={{
              name: current.nombre,
              meta: `${current.server_name} · ${current.dsn_var}\nlast test: —`,
            }}
            statePill={{ label: "registered", tone: "ok" }}
            actions={detailActions}
            focusedAction={actionCursor}
            banner={
              mode.kind === "confirm-delete" ? (
                <ConfirmBanner
                  title={`× Remove ${mode.name}?`}
                  body={`This deletes the entry from profile.json and unexports ${current.dsn_var}. Not reversible.`}
                />
              ) : null
            }
          />
        ) : mode.kind === "wizard-name" || mode.kind === "wizard-dsn" ? (
          <Box flexDirection="column">
            <Text color={colors.borderFaint}>{"│"}</Text>
            <Box flexDirection="column" width={38} paddingLeft={1}>
              <Box>
                <Text color={colors.accent} bold>
                  + New connection
                </Text>
              </Box>
              <Text color={colors.dim} wrap="truncate-end">
                2-step wizard · profile.json
              </Text>

              <Box marginTop={1} flexDirection="column">
                <Text color={colors.mute}>STEPS</Text>
                <WizardStep
                  index={1}
                  label="Alias"
                  active={mode.kind === "wizard-name"}
                  completed={mode.kind === "wizard-dsn"}
                  value={mode.kind === "wizard-dsn" ? mode.name : undefined}
                />
                <WizardStep
                  index={2}
                  label="DSN env var"
                  active={mode.kind === "wizard-dsn"}
                  completed={false}
                />
              </Box>

              <Box marginTop={1} flexDirection="column">
                <Text color={colors.borderFaint}>{"─".repeat(36)}</Text>
                <Text color={colors.faint}>⏎ next · esc cancel</Text>
              </Box>
            </Box>
          </Box>
        ) : null}
      </Box>

      <Box marginTop={1}>
        <QuickActions actions={[{ key: "a", label: "add connection" }]} />
      </Box>
    </Box>
  );

  async function registerConnection(name: string, dsnVar: string) {
    setMode({ kind: "busy", label: `registering ${name}…` });
    try {
      const result = await selfMcpConfig(buildArgs("use-env", { name, "dsn-var": dsnVar }), ctx);
      const summary = result.data?.summary ?? result.error?.message ?? "";
      onToast?.({
        tone: result.ok ? "ok" : "err",
        title: result.ok ? "Connection registered" : "Failed",
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

function WizardStep({
  index,
  label,
  active,
  completed,
  value,
  hint,
}: {
  index: number;
  label: string;
  active: boolean;
  completed: boolean;
  value?: string | undefined;
  hint?: string | undefined;
}) {
  const glyph = completed ? icons.check : active ? "→" : " ";
  const color = completed ? colors.ok : active ? colors.accent : colors.dim;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color={active ? colors.accent : colors.faint}>{active ? icons.focusBar : " "}</Text>
        <Text color={color} bold={active}>
          {glyph} {index}. {label}
        </Text>
      </Box>
      {value ? (
        <Box marginLeft={3}>
          <Text color={colors.ok}>{value}</Text>
        </Box>
      ) : null}
      {hint ? (
        <Box marginLeft={3}>
          <Text color={colors.dim}>{hint}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
