import { basename } from "node:path";
import { Box, Text, useApp, useInput } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ExitCode } from "../../domain/types.js";
import type { MenuAction } from "../interactive-menu.js";
import type { CliContext } from "../types.js";
import type { ActivityEvent } from "./components/activity-feed.js";
import { HomeFooter } from "./components/home-footer.js";
import { HomeHeader } from "./components/home-header.js";
import { NotificationStack } from "./components/notification-stack.js";
import { ScreenFrame } from "./components/screen-frame.js";
import { TabBar } from "./components/tab-bar.js";
import type { TabId, WorkspaceContext } from "./components/tabs-config.js";
import { loadActivity } from "./data/activity.js";
import { InputLockProvider, useInputLock } from "./input-lock.js";
import { NotificationCenterProvider, useNotifications } from "./notification-center.js";
import { McpTab } from "./tabs/mcp-tab.js";
import { ProjectTab } from "./tabs/project-tab.js";
import { SkillsTab } from "./tabs/skills-tab.js";
import { StatusTab } from "./tabs/status-tab.js";
import { WorkflowTab } from "./tabs/workflow-tab.js";
import { colors } from "./theme.js";

export type TuiResult =
  | { kind: "menu-action"; action: MenuAction }
  | { kind: "exit"; exitCode: ExitCode };

const TAB_ORDER: readonly TabId[] = ["status", "workflow", "project", "mcp", "skills"] as const;

const TAB_BY_KEY: Record<string, TabId> = {
  "1": "status",
  "2": "workflow",
  "3": "project",
  "4": "mcp",
  "5": "skills",
};

export interface AppProps {
  version: string;
  ctx: CliContext;
  onResult: (result: TuiResult) => void;
}

export function App(props: AppProps) {
  return (
    <InputLockProvider>
      <NotificationCenterProvider>
        <AppShell {...props} />
      </NotificationCenterProvider>
    </InputLockProvider>
  );
}

function AppShell({ version, ctx, onResult }: AppProps) {
  // Pestaña actual. Por default Status — alineado con el screenshot de diseño.
  const [activeTab, setActiveTab] = useState<TabId>("status");
  // projectName se hidrata async desde el cwd (package.json#name o basename).
  // Placeholder vacío para no parpadear con un brand incorrecto al boot.
  const [projectName, setProjectName] = useState<string>("");
  const [workspaceCtx, setWorkspaceCtx] = useState<WorkspaceContext>({
    branchLabel: "— · loading",
    sessionsLabel: "— sessions",
  });
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [activePhase, setActivePhase] = useState<number>(0);
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

  useEffect(() => {
    void (async () => {
      const name = await resolveProjectName(ctx);
      setProjectName(name);
      const wctx = await loadWorkspaceContext(ctx);
      setWorkspaceCtx(wctx);
      const events = await loadActivity(ctx, { cap: 10 });
      setActivity(events);
      const phase = await loadActivePhase(ctx);
      setActivePhase(phase);
    })();
  }, [ctx]);

  // Update-available banner. Antes vivía dentro de StatusTab — ahora es
  // responsabilidad del shell para que aparezca sin importar la tab activa.
  //
  // `manual` distingue el boot-check (silencioso) del recheck disparado por
  // el usuario vía `r` action (feedback explícito "Checking…" / "Up to date").
  const runUpdateCheck = useCallback(
    async (opts?: { manual?: boolean }) => {
      const manual = opts?.manual === true;
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
          pushToast({
            tone: "err",
            title: "Update check failed",
            body: result.stderr.trim() || "npm view returned non-zero exit.",
          });
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
              <Text color={colors.warn}>↻ </Text>
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
              key: "i",
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
        pushToast({
          tone: "err",
          title: "Update check failed",
          body: (err as Error).message,
        });
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
      if (id === "project-init") {
        onResult({ kind: "menu-action", action: "project-init" });
        exit();
        return;
      }
      if (id === "hub-init") {
        onResult({ kind: "menu-action", action: "hub-init" });
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
      pushToast({ tone: "info", title: id });
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
      const target = TAB_BY_KEY[input];
      if (target) setActiveTab(target);
    },
    { isActive: true },
  );

  const hasNotifs = notifications.length > 0;

  return (
    <ScreenFrame>
      <Box flexDirection="column" flexGrow={1}>
        <HomeHeader brand={projectName} version={version} workspaceContext={workspaceCtx} />
        <NotificationStack items={notifications} />
        <TabBar activeTabId={activeTab} />
        <Box
          flexDirection="column"
          flexGrow={1}
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
              recentEvents={activity}
            />
          ) : null}
          {activeTab === "workflow" ? (
            <WorkflowTab ctx={ctx} isActive={true} activePhase={activePhase} />
          ) : null}
          {activeTab === "project" ? (
            <ProjectTab ctx={ctx} isActive={true} onRunAction={runAction} />
          ) : null}
          {activeTab === "mcp" ? <McpTab ctx={ctx} isActive={true} onToast={pushToast} /> : null}
          {activeTab === "skills" ? (
            <SkillsTab ctx={ctx} isActive={true} version={version} onToast={pushToast} />
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
    const sessRes = await ctx.process.run(ctx.runtime.binName, ["sessions"], { cwd });
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

/**
 * Mapea fase de sesión activa (planning/execution/validation/closure) al
 * phase number del workflow tab (Discover=1, Start=2, Plan=3, Work=4, Close=5).
 * Si no hay sesión activa, retorna 0 (idle).
 */
async function loadActivePhase(ctx: CliContext): Promise<number> {
  try {
    const sessRes = await ctx.process.run(ctx.runtime.binName, ["sessions"], {
      cwd: ctx.env.cwd(),
    });
    if (sessRes.code !== 0) return 0;
    const data = JSON.parse(sessRes.stdout) as {
      sessions?: Array<{ phase?: string; state?: string }>;
    };
    const active = (data.sessions ?? []).find((s) => s.state === "active");
    if (!active) return 0;
    switch (active.phase) {
      case "planning":
        return 3;
      case "execution":
      case "validation":
        return 4;
      case "closure":
        return 5;
      default:
        return 4;
    }
  } catch {
    return 0;
  }
}
