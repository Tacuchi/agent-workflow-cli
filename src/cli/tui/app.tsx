import { basename } from "node:path";
import { Box, Text, useApp, useInput } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatTuiEvent } from "../../application/logging/log-events.js";
import { writeNamespacePin } from "../../application/self/namespace-info.js";
import type { ExitCode } from "../../domain/types.js";
import type { MenuAction } from "../interactive-menu.js";
import type { CliContext } from "../types.js";
import { HomeFooter } from "./components/home-footer.js";
import { HomeHeader } from "./components/home-header.js";
import { NotificationStack } from "./components/notification-stack.js";
import { ScreenFrame } from "./components/screen-frame.js";
import { TabBar } from "./components/tab-bar.js";
import { TABS_LIST, type TabId, type WorkspaceContext } from "./components/tabs-config.js";
import type { LogEntry } from "./data/logs.js";
import { loadLogs } from "./data/logs.js";
import { InputLockProvider, useInputLock } from "./input-lock.js";
import { NotificationCenterProvider, useNotifications } from "./notification-center.js";
import { ConfigTab } from "./tabs/config-tab.js";
import { McpTab } from "./tabs/mcp-tab.js";
import { ProjectTab } from "./tabs/project-tab.js";
import { SkillsTab } from "./tabs/skills-tab.js";
import { StatusTab } from "./tabs/status-tab.js";
import { WorkflowTab } from "./tabs/workflow-tab.js";
import { applyAccent, colors } from "./theme.js";
import { DEFAULT_TUI_PREFS, type TuiPrefs, TuiPrefsService } from "./tui-prefs.js";

export type TuiResult =
  | { kind: "menu-action"; action: MenuAction }
  | { kind: "exit"; exitCode: ExitCode };

// Orden y keymap derivados de TABS_LIST (única fuente). Agregar un tab allá lo
// propaga acá sin tocar este archivo.
const TAB_ORDER: readonly TabId[] = TABS_LIST.map((t) => t.id);

const TAB_BY_KEY: Record<string, TabId> = Object.fromEntries(TABS_LIST.map((t) => [t.key, t.id]));

export interface AppProps {
  version: string;
  ctx: CliContext;
  onResult: (result: TuiResult) => void;
  /** Prefs cargadas en boot (run.tsx). Opcional para tests → defaults. */
  initialPrefs?: TuiPrefs;
}

export function App(props: AppProps) {
  return (
    <InputLockProvider>
      <NotificationCenterProvider {...(props.ctx.logger ? { logger: props.ctx.logger } : {})}>
        <AppShell {...props} />
      </NotificationCenterProvider>
    </InputLockProvider>
  );
}

function AppShell({ version, ctx, onResult, initialPrefs }: AppProps) {
  const prefs0 = initialPrefs ?? DEFAULT_TUI_PREFS;
  // Pestaña actual. Default = initialScreen de las prefs (antes hardcoded Status).
  const [activeTab, setActiveTab] = useState<TabId>(prefs0.initialScreen);
  const [prefs, setPrefs] = useState<TuiPrefs>(prefs0);
  const prefsSvc = useMemo(() => new TuiPrefsService(ctx.fs, ctx.paths), [ctx]);

  // Cambio de pref desde el tab Config. Persiste + aplica vivo. El re-render por
  // setPrefs hace que los hijos re-lean el `colors` ya mutado por applyAccent
  // (sin memoización de por medio → propaga a todo el árbol).
  const onChangePrefs = useCallback(
    (patch: Partial<TuiPrefs>) => {
      if (patch.accentColor) applyAccent(patch.accentColor);
      setPrefs((prev) => ({ ...prev, ...patch }));
      void prefsSvc.save(patch);
    },
    [prefsSvc],
  );
  // Persiste el namespace en el config file que lee NamespaceResolver
  // (~/.config/agent-workflow/namespace). Aplica al próximo arranque.
  const onSaveNamespace = useCallback(
    (ns: string) => {
      void writeNamespacePin(ctx.fs, ctx.env.homeDir(), ns);
    },
    [ctx],
  );
  // projectName se hidrata async desde el cwd (package.json#name o basename).
  // Placeholder vacío para no parpadear con un brand incorrecto al boot.
  const [projectName, setProjectName] = useState<string>("");
  const [workspaceCtx, setWorkspaceCtx] = useState<WorkspaceContext>({
    branchLabel: "— · loading",
    sessionsLabel: "— sessions",
  });
  const [logs, setLogs] = useState<LogEntry[]>([]);
  // Bumpeado por `r`: re-monta el tab activo (re-fetch de sus effects) y recarga
  // los datos del shell (header + historial de logs del tab Status).
  const [refreshNonce, setRefreshNonce] = useState(0);
  const { exit } = useApp();
  const { locked: inputLocked } = useInputLock();
  const {
    items: notifications,
    push: pushNotification,
    pushToast,
    dismiss,
    dismissTop,
    triggerAction,
  } = useNotifications();
  const updateCheckStartedRef = useRef(false);

  const loadShellData = useCallback(async () => {
    const name = await resolveProjectName(ctx);
    setProjectName(name);
    const wctx = await loadWorkspaceContext(ctx);
    setWorkspaceCtx(wctx);
    const dailyLogs = await loadLogs(ctx);
    setLogs(dailyLogs);
  }, [ctx]);

  useEffect(() => {
    void loadShellData();
  }, [loadShellData]);

  // Update-available banner. Antes vivía dentro de StatusTab — ahora es
  // responsabilidad del shell para que aparezca sin importar la tab activa.
  //
  // `manual` distingue el boot-check (silencioso) del recheck disparado por
  // el usuario vía `r` action (feedback explícito "Checking…" / "Up to date").
  const runUpdateCheck = useCallback(
    async (opts?: { manual?: boolean }) => {
      const manual = opts?.manual === true;
      // Manual recheck: feedback explícito. Boot-check: un error de registry
      // (offline, npm hiccup) es ruido benigno → al log diario, no toast rojo.
      const reportFailure = (detail: string) => {
        if (manual) {
          pushToast({ tone: "err", title: "Update check failed", body: detail });
        } else {
          void ctx.logger?.warn(formatTuiEvent("update check", "failed", detail));
        }
      };
      if (manual) {
        pushToast({ tone: "info", title: "Checking npm registry…" });
      }
      try {
        const result = await ctx.process.run(
          "npm",
          ["view", ctx.runtime.packageName, "version"],
          {},
        );
        if (result.code !== 0) {
          reportFailure(result.stderr.trim() || "npm view returned non-zero exit.");
          return;
        }
        const latest = result.stdout.trim();
        if (!latest) return;
        if (latest === version) {
          dismiss("update-available");
          if (manual) {
            pushToast({ tone: "ok", title: "Up to date", body: `v${version}` });
          }
          return;
        }
        pushNotification({
          id: "update-available",
          tone: "warn",
          title: (
            <Text>
              <Text color={colors.bright} bold>
                v{version}
              </Text>
              <Text color={colors.dim}> → </Text>
              <Text color={colors.bright} bold>
                v{latest}
              </Text>
              <Text color={colors.dim}> available</Text>
            </Text>
          ),
          actions: [
            {
              // 'u' y no 'i': ink despacha cada tecla a TODOS los useInput
              // activos, e 'i' es el atajo empty-state de la administración por
              // host — con el banner arriba dispararía install + update a la vez.
              key: "u",
              label: "apply",
              emphasis: true,
              run: () => {
                onResult({ kind: "menu-action", action: "update" });
                exit();
              },
            },
            { key: "r", label: "recheck", run: () => void runUpdateCheck({ manual: true }) },
            {
              key: "o",
              label: "notes",
              run: () =>
                pushToast({
                  tone: "info",
                  title: "Release notes",
                  body: `https://www.npmjs.com/package/${ctx.runtime.packageName}`,
                }),
            },
          ],
        });
      } catch (err) {
        reportFailure((err as Error).message);
      }
    },
    [ctx, version, pushNotification, pushToast, dismiss, onResult, exit],
  );

  useEffect(() => {
    if (updateCheckStartedRef.current) return;
    updateCheckStartedRef.current = true;
    void runUpdateCheck();
  }, [runUpdateCheck]);

  /**
   * Despacha acciones provenientes de las tabs y la palette.
   * Las acciones que requieren ejecutar un comando CLI con stdin (init, doctor,
   * update) salen del TUI primero y se manejan en `dispatchMenuAction` del main.
   */
  const runAction = useCallback(
    (id: string, _payload?: Record<string, unknown>) => {
      // Exits-to-CLI vía MenuAction.
      if (id === "workspace-init") {
        onResult({ kind: "menu-action", action: "workspace-init" });
        exit();
        return;
      }
      if (id === "install-skill") {
        onResult({ kind: "menu-action", action: "install-skill" });
        exit();
        return;
      }
      if (id === "self:doctor") {
        onResult({ kind: "menu-action", action: "doctor" });
        exit();
        return;
      }
      if (id === "self:update") {
        onResult({ kind: "menu-action", action: "update" });
        exit();
        return;
      }
      if (id === "self:help") {
        onResult({ kind: "menu-action", action: "help" });
        exit();
        return;
      }
      if (id === "self:mcp-cli") {
        onResult({ kind: "menu-action", action: "mcp" });
        exit();
        return;
      }
      if (id === "quit") {
        onResult({ kind: "exit", exitCode: 0 });
        exit();
        return;
      }
      // Hints in-app (navegación + toasts).
      if (id === "mcp:add") {
        setActiveTab("mcp");
        pushToast({
          tone: "info",
          title: "MCP · new connection",
          body: "Press `a` to open the wizard.",
        });
        return;
      }
      if (id === "git:status") {
        pushToast({
          tone: "info",
          title: "git status",
          body: "Open your terminal to see details.",
        });
        return;
      }
      // Unknown/unwired id — surface it explicitly (never echo the raw id as if
      // it were a real action). Err tone routes it through the log safety net too.
      pushToast({ tone: "err", title: "Acción no disponible", body: id });
    },
    [pushToast, onResult, exit],
  );

  const rotateTab = useCallback((direction: 1 | -1) => {
    setActiveTab((current) => {
      const idx = TAB_ORDER.indexOf(current);
      const next = (idx + direction + TAB_ORDER.length) % TAB_ORDER.length;
      return TAB_ORDER[next] ?? current;
    });
  }, []);

  useInput(
    (input, key) => {
      if (inputLocked) return;

      // Notif keys tienen prioridad: si hay notifs activas, `x` dismiss el top
      // y las teclas de action (i/r/o/d/…) disparan la acción del item más
      // nuevo que las tenga.
      if (notifications.length > 0 && !key.ctrl && !key.meta) {
        if (input === "x" || input === "X") {
          if (dismissTop()) return;
        } else if (input) {
          if (triggerAction(input)) return;
        }
      }

      if (key.tab) {
        rotateTab(key.shift ? -1 : 1);
        return;
      }
      if (input === "q" || input === "Q") {
        onResult({ kind: "exit", exitCode: 0 });
        exit();
        return;
      }
      // Refresh: re-monta el tab activo (vía refreshNonce) y recarga el shell.
      // Si una notif reclama `r` (recheck del update banner), gana arriba.
      // En el tab Config, `r` lo consume ese tab (reset all) → no refrescar acá.
      if ((input === "r" || input === "R") && activeTab !== "config") {
        setRefreshNonce((n) => n + 1);
        void loadShellData();
        pushToast({ tone: "info", title: "Refreshing…", duration: 1200 });
        return;
      }
      const target = TAB_BY_KEY[input];
      if (target) setActiveTab(target);
    },
    { isActive: true },
  );

  const hasNotifs = notifications.length > 0;

  return (
    <ScreenFrame>
      <Box flexDirection="column" flexGrow={1} minHeight={0}>
        <HomeHeader brand={projectName} version={version} workspaceContext={workspaceCtx} />
        <NotificationStack items={notifications} />
        <TabBar activeTabId={activeTab} />
        {/* flexShrink + minHeight=0 + overflowY=hidden: el contenido del tab
            activo clipea dentro de su región (no empuja el footer fuera de
            pantalla). El scroll interno para tabs altos llega en T2. */}
        <Box
          key={refreshNonce}
          flexDirection="column"
          flexGrow={1}
          flexShrink={1}
          minHeight={0}
          overflowY="hidden"
          borderStyle="single"
          borderColor={colors.accent}
          paddingX={2}
          paddingY={1}
        >
          {activeTab === "status" ? (
            <StatusTab
              ctx={ctx}
              version={version}
              isActive={true}
              onActivateTab={(t) => setActiveTab(t)}
              onToast={pushToast}
              logs={logs}
              {...(prefs.lastOpenApp !== undefined ? { lastOpenApp: prefs.lastOpenApp } : {})}
              onSetLastApp={(app) => onChangePrefs({ lastOpenApp: app })}
              disabledHosts={prefs.disabledHosts}
            />
          ) : null}
          {activeTab === "workflow" ? (
            <WorkflowTab ctx={ctx} isActive={true} onToast={pushToast} />
          ) : null}
          {activeTab === "project" ? (
            <ProjectTab ctx={ctx} isActive={true} onRunAction={runAction} />
          ) : null}
          {activeTab === "mcp" ? <McpTab ctx={ctx} isActive={true} onToast={pushToast} /> : null}
          {activeTab === "skills" ? (
            <SkillsTab ctx={ctx} isActive={true} onToast={pushToast} />
          ) : null}
          {activeTab === "config" ? (
            <ConfigTab
              ctx={ctx}
              isActive={true}
              prefs={prefs}
              onChange={onChangePrefs}
              onSaveNamespace={onSaveNamespace}
            />
          ) : null}
        </Box>
        <HomeFooter showDismiss={hasNotifs} />
      </Box>
    </ScreenFrame>
  );
}

/**
 * Resuelve el nombre del proyecto a mostrar en el header.
 * Prioridad: `package.json#name` (sin scope `@org/`) → `basename(cwd)`.
 * Cualquier error de lectura/parsing cae al fallback de basename.
 */
async function resolveProjectName(ctx: CliContext): Promise<string> {
  const cwd = ctx.env.cwd();
  try {
    const pkgPath = `${cwd}/package.json`;
    if (await ctx.fs.exists(pkgPath)) {
      const raw = await ctx.fs.readText(pkgPath);
      const pkg = JSON.parse(raw) as { name?: string };
      const name = (pkg.name ?? "").trim();
      if (name) {
        const slash = name.lastIndexOf("/");
        return slash >= 0 ? name.slice(slash + 1) : name;
      }
    }
  } catch {
    // fallback abajo
  }
  return basename(cwd) || "workspace";
}

async function loadWorkspaceContext(ctx: CliContext): Promise<WorkspaceContext> {
  const cwd = ctx.env.cwd();

  // Branch + sync
  let branchLabel = "— · no git";
  try {
    const branchRes = await ctx.process.run("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
    });
    if (branchRes.code === 0) {
      const branch = branchRes.stdout.trim();
      const dirtyRes = await ctx.process
        .run("git", ["status", "--porcelain"], { cwd })
        .catch(() => null);
      const isDirty = (dirtyRes?.stdout.trim() ?? "").length > 0;
      const aheadRes = await ctx.process
        .run("git", ["rev-list", "--count", "--left-right", "@{u}...HEAD"], { cwd })
        .catch(() => null);
      const aheadBehind = aheadRes?.stdout.trim().split(/\s+/);
      const behind = aheadBehind?.[0] ?? "0";
      const ahead = aheadBehind?.[1] ?? "0";
      const sync =
        ahead !== "0" || behind !== "0" ? `${ahead}↑ ${behind}↓` : isDirty ? "dirty" : "in sync";
      branchLabel = `${branch} · ${sync}`;
    }
  } catch {
    // keep default
  }

  // Sessions count
  let sessionsLabel = "— sessions";
  try {
    // Re-entrant call: flag it internal so the spawned `aw` keeps its own
    // invocation out of the daily log (main.ts gates the Logger on
    // AW_INTERNAL_CALL). The child still needs the full env (PATH etc.), and the
    // adapter replaces `env` wholesale, so merge rather than pass the flag alone.
    const sessRes = await ctx.process.run(ctx.runtime.binName, ["sessions"], {
      cwd,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
        ),
        AW_INTERNAL_CALL: "1",
      },
    });
    if (sessRes.code === 0) {
      const data = JSON.parse(sessRes.stdout) as {
        active_count?: number;
        total_count?: number;
      };
      const active = data.active_count ?? 0;
      const total = data.total_count ?? 0;
      sessionsLabel = `${total} sessions · ${active} active`;
    }
  } catch {
    // keep default
  }

  return { branchLabel, sessionsLabel };
}
