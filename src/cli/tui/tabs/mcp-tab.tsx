import { Box, Text, useInput, useStdout } from "ink";
import { useCallback, useMemo, useState } from "react";
import { homeRelative } from "../../../application/display-path.js";
import { formatTuiEvent } from "../../../application/logging/log-events.js";
import { testMcpConnection } from "../../../application/mcp-test-connection-service.js";
import {
  type SelfMcpConfigData,
  type SelfMcpConnectionView,
  isDsnVisible,
  selfMcpConfig,
} from "../../../application/self/mcp-config.js";
import { harnessForMcpHost } from "../../../domain/harnesses.js";
import type { McpHost } from "../../../domain/mcp-entry.js";
import type { CommandResult } from "../../../domain/types.js";
import type { CliContext } from "../../types.js";
import { ConfirmBanner } from "../components/confirm-banner.js";
import { type DetailAction, DetailPanel } from "../components/detail-panel.js";
import { InputPrompt } from "../components/input-prompt.js";
import { ListRow } from "../components/list-row.js";
import { notificationStackRows } from "../components/notification-stack.js";
import { PageHead } from "../components/page-head.js";
import { QuickActions } from "../components/quick-actions.js";
import { SectionHead } from "../components/section-head.js";
import { useLockWhile } from "../input-lock.js";
import { type ToastBridgeInput, useNotificationItems } from "../notification-center.js";
import { rowWidth } from "../row-width.js";
import { colors, icons } from "../theme.js";
import { useListDetailKeys } from "../use-list-detail-keys.js";
import { useListWindow, windowRangeHint } from "../use-list-window.js";
import { useOnMount } from "../use-on-mount.js";
import {
  INSTALLABLE_MCP_HOSTS,
  buildArgs,
  installDestination,
  mcpHostLabel,
  mcpRuntimeAggregatePill,
  mcpRuntimeStateSummary,
  suggestDsnVar,
} from "./mcp-tab-helpers.js";

// Hosts the picker offers, from the registry — never a hardcoded "claude".
const HOST_CHOICES: readonly McpHost[] = INSTALLABLE_MCP_HOSTS;

// Rows the chrome consumes around the connections list; the window
// (useListWindow) gets what remains of the viewport:
//   app shell 16 = ScreenFrame border+paddingY 4 · HomeHeader 3 (2 rows +
//     marginBottom) · TabBar 3 (border + row) · tab content box
//     border+paddingY 4 · HomeFooter 2 (marginTop + row)
//   this tab 6 = PageHead 2 (row + marginBottom) · SectionHead 1 ·
//     QuickActions 3 (marginTop + rule + keys)
// Plus, added per render at the call site: the NotificationStack height
// (notificationStackRows — 0 unless a banner is visible).
const MCP_LIST_RESERVED_ROWS = 22;

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
  // Install used to go straight to Claude while the panel promised "the host's
  // config". The host is now chosen, and only file-writing hosts are offered.
  | { kind: "select-host"; name: string; cursor: number }
  | { kind: "busy"; label: string };

type ActionId = "install" | "test" | "edit" | "remove";

// Detail panel action ids, in render order (paired 1:1 with `detailActions`).
const DETAIL_ACTION_IDS: ActionId[] = ["install", "test", "edit", "remove"];

export interface McpTabProps {
  ctx: CliContext;
  isActive: boolean;
  onToast?: (msg: ToastBridgeInput) => void;
  /** Hosts [Config] turned off — they leave the install destinations. */
  disabledHosts?: readonly string[];
}

// Crash-safe DSN visibility check (env + local dsn file) for the review
// step's badge. Defensive: a malformed ctx reads as "not visible", never throws.
function safeDsnVisible(ctx: CliContext, dsnVar: string): boolean {
  try {
    return isDsnVisible(ctx, dsnVar);
  } catch {
    return false;
  }
}

export function McpTab({ ctx, isActive, onToast, disabledHosts = [] }: McpTabProps) {
  const [connections, setConnections] = useState<SelfMcpConnectionView[]>([]);
  const [registryIssue, setRegistryIssue] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const { stdout } = useStdout();

  // An MCP host is named by its own id, so the opt-out is resolved THROUGH the
  // catalog rather than by comparing two different vocabularies of "host". A
  // host the catalog cannot resolve stays offered on purpose: hiding a
  // destination we failed to classify would be worse than showing it, and the
  // catalog guard already proves every McpHost has its spec.
  const hostChoices = useMemo(() => {
    if (disabledHosts.length === 0) return HOST_CHOICES;
    const off = new Set(disabledHosts);
    return HOST_CHOICES.filter((h) => {
      const target = harnessForMcpHost(h)?.installTarget;
      return target === undefined || !off.has(target);
    });
  }, [disabledHosts]);

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
      void runRawAction("remove", name, `removing ${name}…`).then(async (summary) => {
        if (summary !== null) {
          onToast?.({
            tone: "ok",
            title: `Connection '${name}' removed`,
            ...(summary.length === 0 ? {} : { body: summary }),
          });
        }
        await refresh();
        setMode({ kind: "list" });
      });
    },
  });

  // Windowed slice of the connections list (shared hook): renders only the
  // rows that fit the viewport, following the cursor at the edges. Non-TTY
  // (unknown height) → the whole list renders, as before. The NotificationStack
  // height joins the reservation so a visible banner can't clip the active row.
  const notifItems = useNotificationItems();
  const listWindow = useListWindow(
    connections.length,
    cursor,
    MCP_LIST_RESERVED_ROWS + notificationStackRows(notifItems),
  );

  // Host picker keys (↑↓ · ⏎ install · esc back). Its own handler: the shared
  // list/detail hook is off in this mode.
  useInput(
    (_input, key) => {
      if (mode.kind !== "select-host") return;
      if (key.upArrow) return setMode({ ...mode, cursor: Math.max(0, mode.cursor - 1) });
      if (key.downArrow)
        return setMode({ ...mode, cursor: Math.min(hostChoices.length - 1, mode.cursor + 1) });
      if (key.escape) return setMode({ kind: "detail" });
      if (key.return) {
        const host = hostChoices[mode.cursor];
        if (host) void runInstall(mode.name, host);
      }
    },
    { isActive: isActive && mode.kind === "select-host" },
  );

  const refresh = useCallback(async () => {
    try {
      const result = await selfMcpConfig(buildArgs("list"), ctx);
      if (!result.ok) {
        const recovery =
          result.data?.registry_error?.recovery ??
          result.error?.message ??
          "MCP registry requires repair.";
        setConnections([]);
        setRegistryIssue(recovery);
        onToast?.({ tone: "err", title: "MCP registry needs repair", body: recovery });
        return;
      }
      const next = result.data?.connections ?? [];
      setConnections(next);
      setRegistryIssue(null);
      setCursor((c) => Math.min(Math.max(0, c), Math.max(0, next.length - 1)));
    } catch (err) {
      onToast?.({ tone: "err", title: "Error loading MCP", body: (err as Error).message });
    }
  }, [ctx, onToast, setCursor]);

  useOnMount(() => void refresh());

  const current = connections[cursor] ?? null;

  const runRawAction = useCallback(
    async (action: string, name: string, label: string): Promise<string | null> => {
      setMode({ kind: "busy", label });
      try {
        const result: CommandResult<SelfMcpConfigData> = await selfMcpConfig(
          buildArgs(action, { name }),
          ctx,
        );
        if (!result.ok) {
          // The summary is the sentence a person can act on (what happened, which
          // file kept a foreign entry); the error message points at JSON fields
          // this screen never shows.
          const summary = result.data?.summary ?? result.error?.message ?? "failed";
          onToast?.({ tone: "err", title: `Step ${action} failed`, body: summary });
          return null;
        }
        void ctx.logger?.info(formatTuiEvent(`mcp ${action} ${name}`, "ok"));
        return result.data?.summary ?? "";
      } catch (err) {
        onToast?.({ tone: "err", title: "Error", body: (err as Error).message });
        return null;
      }
    },
    [ctx, onToast],
  );

  /** Test connection executes a read-only PostgreSQL SELECT 1. */
  const runTestConnection = useCallback(
    async (name: string, dsnVar: string) => {
      setMode({ kind: "busy", label: `testing ${name} → PostgreSQL…` });
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
            body: `PostgreSQL respondió SELECT 1 usando ${dsnVar} (${result.source ?? "unknown"})`,
          });
          void ctx.logger?.info(formatTuiEvent(`mcp test ${name}`, "ok"));
        } else {
          onToast?.({
            tone: "err",
            title: `Test failed · ${name}`,
            body: result.error ?? "PostgreSQL no pudo conectar",
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

  // Install the connection into the CHOSEN host's user-scope config via the
  // backend's `install-<host>` action (runMcpSetup, scope=global; the button
  // press is the consent the guard asks for).
  const runInstall = useCallback(
    async (name: string, host: McpHost) => {
      setMode({ kind: "busy", label: `installing ${name} → ${installDestination(host)}…` });
      try {
        const result = await selfMcpConfig(buildArgs(`install-${host}`, { name }), ctx);
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
          setMode({ kind: "select-host", name: current.nombre, cursor: 0 });
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
    // `runInstall` is no longer called here: Install opens the host picker and
    // the picker's handler runs it.
    [current, runTestConnection],
  );

  // Detail panel actions (Install/Test/Edit/Remove). Install always starts with
  // an explicit host picker; a row can represent several independent hosts.
  const detailActions: DetailAction[] = current
    ? [
        {
          name: "Install in host…",
          description: "Choose a user-scope host for the reliable Workline PostgreSQL server.",
        },
        { name: "Test connection", description: "Run a read-only PostgreSQL SELECT 1." },
        { name: "Edit connection", description: "Alias / DSN env var." },
        {
          name: "Remove connection",
          description: "Delete Workline PostgreSQL entries from user configs + local registry.",
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

  // Visible-range indicator for the SectionHead hint slot — only when the
  // window hides rows (consumes no extra terminal row).
  const listRangeHint = windowRangeHint(listWindow, connections.length);

  return (
    <Box flexDirection="column">
      <PageHead
        title="MCP"
        count={{ label: `${connections.length} databases · mcp-connections.json`, tone: "accent" }}
        action={<Text color={colors.mute}>registered aliases · consumed by skills</Text>}
      />

      {/* with-detail layout */}
      <Box flexDirection="row">
        {/* Left: list */}
        <Box flexDirection="column" flexGrow={1} paddingRight={2}>
          <SectionHead
            label="Connections"
            count={connections.length}
            {...(listRangeHint ? { hint: listRangeHint } : {})}
            {...(inWizard
              ? { rightAction: "esc cancel" }
              : mode.kind === "detail" || mode.kind === "confirm-delete"
                ? { rightAction: "esc to close detail" }
                : {})}
          />

          {connections.length === 0 && mode.kind === "list" ? (
            <Box marginLeft={2} marginTop={1} flexDirection="column">
              {registryIssue ? (
                <>
                  <Text color={colors.err}>MCP registry needs repair.</Text>
                  <Text color={colors.dim}>{registryIssue}</Text>
                </>
              ) : (
                <>
                  <Text color={colors.dim}>No MCP connections yet.</Text>
                  <Text color={colors.dim}>
                    Register a DSN to let skills query your DB. Press{" "}
                    <Text color={colors.accent} bold>
                      a
                    </Text>{" "}
                    to start.
                  </Text>
                </>
              )}
            </Box>
          ) : (
            <Box marginTop={0} flexDirection="column">
              {connections
                .slice(listWindow.start, listWindow.start + listWindow.visible)
                .map((connection, i) => {
                  const states = hostRuntimeStates(connection);
                  return (
                    <ListRow
                      key={connection.nombre}
                      icon={icons.diamond}
                      iconActive={true}
                      title={connection.nombre}
                      subtitle={`${connection.dsn_var} · ${connection.server_name} · ${mcpRuntimeStateSummary(states)}`}
                      state={mcpRuntimeAggregatePill(states)}
                      chevron
                      active={listWindow.start + i === cursor}
                      dimmed={inWizard}
                      widthHint={rowWidth(stdout?.columns, overlayOpen)}
                    />
                  );
                })}
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

          {mode.kind === "select-host" ? (
            <Box marginTop={1} flexDirection="column">
              <SectionHead label={`Install ${mode.name} into…`} count={hostChoices.length} />
              {hostChoices.length === 0 ? (
                <Text color={colors.warn}>
                  {`${icons.alertDot} every MCP host is off in [Config] — re-enable one to install`}
                </Text>
              ) : null}
              {hostChoices.map((host, i) => (
                <ListRow
                  key={host}
                  icon={icons.diamond}
                  iconActive={mode.cursor === i}
                  title={mcpHostLabel(host)}
                  subtitle={installDestination(host)}
                  active={mode.cursor === i}
                  widthHint={rowWidth(stdout?.columns, false)}
                />
              ))}
              <Text color={colors.faint}>[⏎] install here · esc cancel</Text>
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
              meta: connectionDetailMeta(current, ctx.env.homeDir()),
            }}
            statePill={mcpRuntimeAggregatePill(hostRuntimeStates(current))}
            actions={detailActions}
            focusedAction={actionCursor}
            banner={
              mode.kind === "confirm-delete" ? (
                <ConfirmBanner
                  title={`× Remove ${mode.name}?`}
                  body={`This removes '${mode.name}' (Workline PostgreSQL entries only) from every host's user config and deletes it from the local registry (mcp-connections.json). Same-named entries Workline did not write stay untouched. Not reversible.`}
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
                    ? "⏎ save · choose host · s save · t test"
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
    let choosingHost = false;
    setMode({ kind: "busy", label: `saving ${name}…` });
    try {
      const saved = await saveConnection(name, dsnVar);
      if (saved) {
        choosingHost = true;
        await refresh();
        setMode({ kind: "select-host", name, cursor: 0 });
        return;
      }
      await refresh();
    } catch (err) {
      onToast?.({ tone: "err", title: "Error", body: (err as Error).message });
    } finally {
      if (!choosingHost) setMode({ kind: "list" });
    }
  }

  async function runWizardTest(review: Extract<Mode, { kind: "wizard-review" }>) {
    setMode({ kind: "busy", label: `testing ${review.dsnVar} → PostgreSQL…` });
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
            ? `PostgreSQL SELECT 1 (${result.source ?? "env"})`
            : (result.error ?? "PostgreSQL could not connect"),
        },
      });
    } catch (err) {
      setMode({ ...review, test: { ok: false, msg: (err as Error).message } });
    }
  }
}

function connectionDetailMeta(connection: SelfMcpConnectionView, home: string): string {
  const hostStates = HOST_CHOICES.map((host) => {
    const state = connection.host_status[host];
    // A same-named entry Workline did not write: say WHERE it is — "conflict"
    // alone reads like a warning and leaves the person guessing.
    const foreign =
      state.entry_state === "foreign" && state.target !== undefined
        ? ` · ajena en ${homeRelative(state.target, home)}`
        : "";
    const receiptFailure =
      state.receipt_failure === undefined
        ? ""
        : ` (${state.receipt_failure.phase}/${state.receipt_failure.code})`;
    const nativeFailure =
      state.native_check_failure === undefined
        ? ""
        : ` (native/${state.native_check_failure.code} @ ${state.native_check_failure.observed_at})`;
    return `${mcpHostLabel(host)}: ${state.state}${foreign}${receiptFailure}${nativeFailure}`;
  });
  const conflictRecovery = HOST_CHOICES.some(
    (host) => connection.host_status[host].entry_state === "foreign",
  )
    ? [
        `Acción: la entrada '${connection.server_name}' marcada ajena no la escribió Workline y no se toca; borrala o renombrala a mano en el archivo indicado de cada host y reinstalá.`,
      ]
    : [];
  const probes = HOST_CHOICES.flatMap((host) => {
    const state = connection.host_status[host];
    return state.last_probe === undefined
      ? []
      : [`${mcpHostLabel(host)} ${state.last_probe.outcome} (${state.last_probe.phase})`];
  });
  const reloadHints: string[] = [];
  if (connection.host_status.claude.reload_required) {
    reloadHints.push("Claude: /mcp → Reconnect o nueva sesión");
  }
  if (connection.host_status.codex.reload_required) {
    reloadHints.push("Codex: /mcp → Restart");
  }
  const receiptRecovery = HOST_CHOICES.some(
    (host) => connection.host_status[host].receipt_failure !== undefined,
  )
    ? ["Acción: reinstalá cada host con evidencia de recibo fallida."]
    : [];
  const nativeRecovery = HOST_CHOICES.some(
    (host) => connection.host_status[host].native_check_failure !== undefined,
  )
    ? ["Acción: revisá el check nativo MCP del host antes de confiar en su carga."]
    : [];
  const fallback =
    connection.host_status.codex.state === "host-load-observed"
      ? []
      : [
          `Fallback directo de Codex (MCP opcional): agent-workflow tool call execute_sql --connection ${connection.nombre} --input-json -`,
        ];
  return [
    `${connection.server_name} · ${connection.dsn_var}`,
    ...hostStates,
    ...(probes.length === 0 ? ["last probe: —"] : probes.map((probe) => `last probe: ${probe}`)),
    ...conflictRecovery,
    ...receiptRecovery,
    ...nativeRecovery,
    ...reloadHints,
    ...fallback,
  ].join("\n");
}

function hostRuntimeStates(connection: SelfMcpConnectionView) {
  return HOST_CHOICES.map((host) => connection.host_status[host].state);
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
