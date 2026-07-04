import { Box, Text, useInput, useStdout } from "ink";
import { useCallback, useState } from "react";
import { formatTuiEvent } from "../../../application/logging/log-events.js";
import { testMcpConnection } from "../../../application/mcp-test-connection-service.js";
import {
  type SelfMcpConfigData,
  type SelfMcpConnectionView,
  isDsnVisible,
  selfMcpConfig,
} from "../../../application/self/mcp-config.js";
import type { CommandResult } from "../../../domain/types.js";
import type { CliContext } from "../../types.js";
import { ConfirmBanner } from "../components/confirm-banner.js";
import { type DetailAction, DetailPanel } from "../components/detail-panel.js";
import { InputPrompt } from "../components/input-prompt.js";
import { ListRow } from "../components/list-row.js";
import { PageHead } from "../components/page-head.js";
import { QuickActions } from "../components/quick-actions.js";
import { SectionHead } from "../components/section-head.js";
import { useLockWhile } from "../input-lock.js";
import type { ToastBridgeInput } from "../notification-center.js";
import { rowWidth } from "../row-width.js";
import { colors, icons } from "../theme.js";
import { useListDetailKeys } from "../use-list-detail-keys.js";
import { useOnMount } from "../use-on-mount.js";
import {
  buildArgs,
  installActionLabel,
  installDestination,
  installStatusPill,
  suggestDsnVar,
} from "./mcp-tab-helpers.js";

type Mode =
  | { kind: "list" }
  | { kind: "detail" }
  | { kind: "wizard-name"; editingName?: string; prefillDsn?: string }
  | { kind: "wizard-dsn"; name: string; prefillDsn?: string; editingExisting?: string }
  | {
      kind: "wizard-review";
      name: string;
      dsnVar: string;
      visible: boolean;
      editingExisting?: string;
      test?: { ok: boolean; msg: string };
    }
  | { kind: "confirm-delete"; name: string }
  | { kind: "busy"; label: string };

type ActionId = "install" | "test" | "edit" | "remove";

// Detail panel action ids, in render order (paired 1:1 with `detailActions`).
const DETAIL_ACTION_IDS: ActionId[] = ["install", "test", "edit", "remove"];

export interface McpTabProps {
  ctx: CliContext;
  isActive: boolean;
  onToast?: (msg: ToastBridgeInput) => void;
}

// Crash-safe DSN visibility check (env + bootstrap dsn file) for the review
// step's badge. Defensive: a malformed ctx reads as "not visible", never throws.
function safeDsnVisible(ctx: CliContext, dsnVar: string): boolean {
  try {
    return isDsnVisible(ctx, dsnVar);
  } catch {
    return false;
  }
}

export function McpTab({ ctx, isActive, onToast }: McpTabProps) {
  const [connections, setConnections] = useState<SelfMcpConnectionView[]>([]);
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const { stdout } = useStdout();

  useLockWhile(mode.kind !== "list" && mode.kind !== "detail");

  // Shared list/detail/confirm keys (↑↓ · ⏎ · esc · a add · y/n). The
  // callbacks close over consts declared below — they only run on keystrokes.
  const { cursor, setCursor, actionCursor } = useListDetailKeys({
    isActive,
    phase:
      mode.kind === "list" || mode.kind === "detail"
        ? mode.kind
        : mode.kind === "confirm-delete"
          ? "confirm"
          : "off",
    listLen: connections.length,
    actionsLen: DETAIL_ACTION_IDS.length,
    onAdd: () => setMode({ kind: "wizard-name" }),
    onOpenDetail: () => setMode({ kind: "detail" }),
    onCloseDetail: () => setMode({ kind: "list" }),
    onRunAction: (i) => {
      const id = DETAIL_ACTION_IDS[i];
      if (id) triggerAction(id);
    },
    onConfirm: (yes) => {
      if (mode.kind !== "confirm-delete") return;
      if (!yes) return setMode({ kind: "detail" });
      const name = mode.name;
      void runRawAction("remove", name, `removing ${name}…`).then(async (ok) => {
        if (ok) onToast?.({ tone: "ok", title: `Connection '${name}' removed` });
        await refresh();
        setMode({ kind: "list" });
      });
    },
  });

  const refresh = useCallback(async () => {
    try {
      const result = await selfMcpConfig(buildArgs("list"), ctx);
      const next = result.ok ? (result.data?.connections ?? []) : [];
      setConnections(next);
      setCursor((c) => Math.min(Math.max(0, c), Math.max(0, next.length - 1)));
    } catch (err) {
      onToast?.({ tone: "err", title: "Error loading MCP", body: (err as Error).message });
    }
  }, [ctx, onToast, setCursor]);

  useOnMount(() => void refresh());

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
        void ctx.logger?.info(formatTuiEvent(`mcp ${action} ${name}`, "ok"));
        return true;
      } catch (err) {
        onToast?.({ tone: "err", title: "Error", body: (err as Error).message });
        return false;
      }
    },
    [ctx, onToast],
  );

  /**
   * Test connection — runs `npx -y @bytebase/dbhub` with the resolved DSN.
   * If dbhub starts without fatal errors within 5s, the connection to the
   * data engine is assumed OK. If dbhub fails fast (invalid DSN, unreachable
   * host, bad credentials), the stderr is reported.
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
          void ctx.logger?.info(formatTuiEvent(`mcp test ${name}`, "ok"));
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

  // Install the connection into the host's user-scope config (claude →
  // ~/.claude.json) via the existing `install-claude` action (runMcpSetup,
  // scope=global; the button press is the consent the guard asks for).
  const runInstall = useCallback(
    async (name: string) => {
      setMode({ kind: "busy", label: `installing ${name} → ${installDestination("claude")}…` });
      try {
        const result = await selfMcpConfig(buildArgs("install-claude", { name }), ctx);
        onToast?.({
          tone: result.ok ? "ok" : "err",
          title: result.ok ? `Installed · ${name}` : `Install failed · ${name}`,
          body: result.data?.summary ?? result.error?.message ?? "",
        });
        if (result.ok) void ctx.logger?.info(formatTuiEvent(`mcp install ${name}`, "ok"));
      } catch (err) {
        onToast?.({ tone: "err", title: "Install failed", body: (err as Error).message });
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
        case "install":
          void runInstall(current.nombre);
          return;
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
    [current, runTestConnection, runInstall],
  );

  // Detail panel actions (Install/Test/Edit/Remove). `Install` adapts its label
  // to the user-scope status: install · update (on drift) · reinstall.
  const detailActions: DetailAction[] = current
    ? [
        {
          name: installActionLabel(current.instalado.claude),
          description: `Write the dbhub entry to ${installDestination("claude")} (user scope).`,
        },
        { name: "Test connection", description: "Run dbhub with DSN (SELECT 1 smoke test)." },
        { name: "Edit connection", description: "Alias / DSN env var." },
        {
          name: "Remove connection",
          description: "Delete dbhub entries from every host's user config + local registry.",
          danger: true,
        },
      ]
    : [];

  // input — esc in wizard
  useInput(
    (_input, key) => {
      if (!isActive) return;
      if (mode.kind === "wizard-name" || mode.kind === "wizard-dsn") {
        if (key.escape) setMode({ kind: "list" });
      }
    },
    { isActive },
  );

  // input — wizard-review (t test · ⏎ save+install · s save only · esc cancel)
  useInput(
    (input, key) => {
      if (!isActive || mode.kind !== "wizard-review") return;
      if (key.escape) {
        setMode({ kind: "list" });
        return;
      }
      if (input === "t" || input === "T") {
        void runWizardTest(mode);
        return;
      }
      if (input === "s" || input === "S") {
        void saveOnly(mode.name, mode.dsnVar);
        return;
      }
      if (key.return) {
        void saveAndInstall(mode.name, mode.dsnVar);
      }
    },
    { isActive },
  );

  const inWizard = mode.kind.startsWith("wizard");
  const overlayOpen = mode.kind !== "list" && mode.kind !== "busy";

  return (
    <Box flexDirection="column">
      <PageHead
        title="MCP"
        count={{ label: `${connections.length} databases · mcp-connections.json`, tone: "accent" }}
        action={<Text color={colors.mute}>aliases match mcp_databases[] · consumed by skills</Text>}
      />

      {/* with-detail layout */}
      <Box flexDirection="row">
        {/* Left: list */}
        <Box flexDirection="column" flexGrow={1} paddingRight={2}>
          <SectionHead
            label="Connections"
            count={connections.length}
            {...(inWizard
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
                  state={installStatusPill(c.instalado.claude)}
                  chevron
                  active={i === cursor}
                  dimmed={inWizard}
                  widthHint={rowWidth(stdout?.columns, overlayOpen)}
                />
              ))}
            </Box>
          )}

          {/* Inline wizard — just a clean SectionHead + InputPrompt (no
              duplication with a decorative input box). */}
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
                      ...(mode.prefillDsn ? { prefillDsn: mode.prefillDsn } : {}),
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
                  defaultValue={mode.prefillDsn ?? suggestDsnVar(mode.name)}
                  onSubmit={(value) => {
                    const dsnVar = value.trim().toUpperCase();
                    if (!dsnVar) {
                      onToast?.({ tone: "err", title: "Empty DSN var" });
                      setMode({ kind: "list" });
                      return;
                    }
                    setMode({
                      kind: "wizard-review",
                      name: mode.name,
                      dsnVar,
                      visible: safeDsnVisible(ctx, dsnVar),
                      ...(mode.editingExisting ? { editingExisting: mode.editingExisting } : {}),
                    });
                  }}
                  isActive={isActive}
                />
              </Box>
            </Box>
          ) : null}
          {mode.kind === "wizard-review" ? (
            <Box flexDirection="column" marginTop={1}>
              <SectionHead
                label={`${mode.editingExisting ? "Edit" : "Register"} connection · ${mode.name}`}
                hint="Step 3 of 3 · Review · test · install"
                rightAction="⏎ save+install · esc cancel"
              />
              <Box marginLeft={2} marginTop={1} flexDirection="column">
                <Box>
                  <Text color={colors.dim}>alias </Text>
                  <Text color={colors.bright} bold>
                    {mode.name}
                  </Text>
                </Box>
                <Box>
                  <Text color={colors.dim}>DSN </Text>
                  <Text color={colors.bright} bold>
                    {mode.dsnVar}
                  </Text>
                  <Text> </Text>
                  {mode.visible ? (
                    <Text color={colors.ok}>{icons.check} visible</Text>
                  ) : (
                    <Text color={colors.warn}>{icons.cross} not in env — export it first</Text>
                  )}
                </Box>
                {mode.test ? (
                  <Box marginTop={1}>
                    <Text color={mode.test.ok ? colors.ok : colors.err}>
                      {mode.test.ok ? icons.check : icons.cross} {mode.test.msg}
                    </Text>
                  </Box>
                ) : null}
                <Box marginTop={1} flexDirection="column">
                  <Text color={colors.borderFaint}>{"─".repeat(40)}</Text>
                  <Text color={colors.faint}>
                    [⏎] save + install · [s] save only · [t] test · esc cancel
                  </Text>
                </Box>
              </Box>
            </Box>
          ) : null}

          {mode.kind === "busy" ? (
            <Box marginTop={1}>
              <Text color={colors.warn}>
                {icons.spinner} {mode.label}
              </Text>
            </Box>
          ) : null}
        </Box>

        {/* Right: detail panel (only after a row was selected with Enter) */}
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
                  body={`This removes '${mode.name}' (dbhub entries only) from every host's user config and deletes it from the local registry (mcp-connections.json). Not reversible.`}
                />
              ) : null
            }
          />
        ) : inWizard ? (
          <Box flexDirection="column">
            <Text color={colors.borderFaint}>{"│"}</Text>
            <Box flexDirection="column" width={38} paddingLeft={1}>
              <Box>
                <Text color={colors.accent} bold>
                  {mode.kind === "wizard-review" && mode.editingExisting
                    ? "✎ Edit connection"
                    : "+ New connection"}
                </Text>
              </Box>
              <Text color={colors.dim} wrap="truncate-end">
                guided · test · install
              </Text>

              <Box marginTop={1} flexDirection="column">
                <Text color={colors.mute}>STEPS</Text>
                <WizardStep
                  index={1}
                  label="Alias"
                  active={mode.kind === "wizard-name"}
                  completed={mode.kind === "wizard-dsn" || mode.kind === "wizard-review"}
                  value={
                    mode.kind === "wizard-dsn" || mode.kind === "wizard-review"
                      ? mode.name
                      : undefined
                  }
                />
                <WizardStep
                  index={2}
                  label="DSN env var"
                  active={mode.kind === "wizard-dsn"}
                  completed={mode.kind === "wizard-review"}
                  value={mode.kind === "wizard-review" ? mode.dsnVar : undefined}
                />
                <WizardStep
                  index={3}
                  label="Test (optional)"
                  active={mode.kind === "wizard-review"}
                  completed={mode.kind === "wizard-review" && mode.test?.ok === true}
                />
                <WizardStep
                  index={4}
                  label="Install → user scope"
                  active={false}
                  completed={false}
                />
              </Box>

              <Box marginTop={1} flexDirection="column">
                <Text color={colors.borderFaint}>{"─".repeat(36)}</Text>
                <Text color={colors.faint}>
                  {mode.kind === "wizard-review"
                    ? "⏎ save+install · s save · t test"
                    : "⏎ next · esc cancel"}
                </Text>
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

  // Register the connection in the local registry, mcp-connections.json (use-env).
  // Returns ok so callers can chain the user-scope install. On a not-visible DSN,
  // use-env surfaces env_help.
  async function saveConnection(name: string, dsnVar: string): Promise<boolean> {
    const result = await selfMcpConfig(buildArgs("use-env", { name, "dsn-var": dsnVar }), ctx);
    onToast?.({
      tone: result.ok ? "ok" : "err",
      title: result.ok ? `Registered · ${name}` : "Save failed",
      body: result.data?.summary ?? result.error?.message ?? "",
    });
    if (result.ok) void ctx.logger?.info(formatTuiEvent(`mcp register ${name}`, "ok"));
    return result.ok;
  }

  async function saveOnly(name: string, dsnVar: string) {
    setMode({ kind: "busy", label: `saving ${name}…` });
    try {
      await saveConnection(name, dsnVar);
      await refresh();
    } catch (err) {
      onToast?.({ tone: "err", title: "Error", body: (err as Error).message });
    } finally {
      setMode({ kind: "list" });
    }
  }

  async function saveAndInstall(name: string, dsnVar: string) {
    setMode({ kind: "busy", label: `saving ${name}…` });
    try {
      const saved = await saveConnection(name, dsnVar);
      if (saved) {
        setMode({ kind: "busy", label: `installing ${name} → ${installDestination("claude")}…` });
        const install = await selfMcpConfig(buildArgs("install-claude", { name }), ctx);
        onToast?.({
          tone: install.ok ? "ok" : "err",
          title: install.ok ? `Installed · ${name}` : `Install failed · ${name}`,
          body: install.data?.summary ?? install.error?.message ?? "",
        });
        if (install.ok) void ctx.logger?.info(formatTuiEvent(`mcp install ${name}`, "ok"));
      }
      await refresh();
    } catch (err) {
      onToast?.({ tone: "err", title: "Error", body: (err as Error).message });
    } finally {
      setMode({ kind: "list" });
    }
  }

  async function runWizardTest(review: Extract<Mode, { kind: "wizard-review" }>) {
    setMode({ kind: "busy", label: `testing ${review.dsnVar} → dbhub…` });
    try {
      const result = await testMcpConnection({
        dsnVar: review.dsnVar,
        env: process.env,
        paths: ctx.paths,
        platform: process.platform,
      });
      setMode({
        ...review,
        test: {
          ok: result.ok,
          msg: result.ok
            ? `dbhub connected (${result.source ?? "env"})`
            : (result.error ?? "dbhub could not connect"),
        },
      });
    } catch (err) {
      setMode({ ...review, test: { ok: false, msg: (err as Error).message } });
    }
  }
}

function WizardStep({
  index,
  label,
  active,
  completed,
  value,
}: {
  index: number;
  label: string;
  active: boolean;
  completed: boolean;
  value?: string | undefined;
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
    </Box>
  );
}
