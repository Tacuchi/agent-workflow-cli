import { Box, Text, useApp, useInput } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { selfDoctor } from "../../application/self/doctor-self.js";
import type { ExitCode } from "../../domain/types.js";
import type { MenuAction } from "../interactive-menu.js";
import type { CliContext } from "../types.js";
import type { ActivityEvent } from "./components/activity-feed.js";
import { CommandPalette, type PaletteCommand } from "./components/command-palette.js";
import { HomeFooter } from "./components/home-footer.js";
import { HomeHeader } from "./components/home-header.js";
import { NotificationStack } from "./components/notification-stack.js";
import { ScreenFrame } from "./components/screen-frame.js";
import { TabBar } from "./components/tab-bar.js";
import type { TabId, WorkspaceContext } from "./components/tabs-config.js";
import { loadActivity } from "./data/activity.js";
import { HOSTS } from "./hosts.js";
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
  // activeTab refleja la pestaña actual incluso con la palette abierta como
  // overlay. Por default Status — alineado con el screenshot de diseño.
  const [activeTab, setActiveTab] = useState<TabId>("status");
  // Palette es overlay opt-in (^K para abrir). Boot va directo a la Status tab.
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteFilter, setPaletteFilter] = useState("");
  const [paletteCursor, setPaletteCursor] = useState(0);
  const [workspaceCtx, setWorkspaceCtx] = useState<WorkspaceContext>({
    modeLabel: "agent-workflow",
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
  const doctorCheckStartedRef = useRef(false);

  useEffect(() => {
    void (async () => {
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

  // Doctor-check banner. Se evalúa una vez al boot: hosts cubiertos vs total +
  // hooks armed para claude. Cualquier deficiencia gatilla la notif.
  useEffect(() => {
    if (doctorCheckStartedRef.current) return;
    doctorCheckStartedRef.current = true;
    void (async () => {
      const doc = await selfDoctor(ctx).catch(() => null);
      if (!doc?.ok || !doc.data) return;
      const installedByTarget = new Map<string, boolean>(
        doc.data.skill.targets.map((t) => [t.target, t.installed]),
      );
      const supportedHosts = HOSTS.length;
      const installedHosts = HOSTS.filter((h) => installedByTarget.get(h.id) === true).length;
      const missing = Math.max(0, supportedHosts - installedHosts);
      const hooksArmed = await detectHooksArmed(ctx);
      const hasIssue = missing > 0 || !hooksArmed;
      if (!hasIssue) return;
      const segments: string[] = [];
      if (missing > 0) segments.push(`${missing} hosts missing skill`);
      if (!hooksArmed) segments.push("claude hooks not armed");
      // Lista de hosts instalados para usar en el summary on-demand (`s`).
      const installedNames = HOSTS.filter((h) => installedByTarget.get(h.id) === true)
        .map((h) => h.short)
        .join(", ");
      pushNotification({
        id: "doctor-check",
        tone: "warn",
        title: `Doctor check · ${segments.join(" · ")}`,
        actions: [
          {
            key: "d",
            label: "run doctor",
            emphasis: true,
            run: () => {
              onResult({ kind: "menu-action", action: "doctor" });
              exit();
            },
          },
          {
            // `s summary` reemplaza al viejo `o open report` para evitar la
            // colisión con el `o notes` del update-available banner.
            key: "s",
            label: "summary",
            run: () =>
              pushToast({
                tone: "info",
                title: `${installedHosts}/${supportedHosts} hosts installed`,
                body: `${installedNames || "none"} · claude hooks: ${hooksArmed ? "armed" : "off"}`,
              }),
          },
        ],
      });
    })();
  }, [ctx, pushNotification, pushToast, onResult, exit]);

  // Derivar alert dot del tab Status: · hay update outdated? · hay doctor warning?
  const statusAlert = useMemo(
    () => notifications.some((n) => n.id === "update-available" || n.id === "doctor-check"),
    [notifications],
  );

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
        setPaletteOpen(false);
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

  // La palette ya no incluye entries `Go to <Tab>` — la TabBar visible cubre
  // esa navegación. Aquí solo viven acciones que disparan comandos o salidas
  // a CLI.
  const allCommands: PaletteCommand[] = useMemo(
    () => [
      {
        id: "install-skill",
        category: "install",
        label: "Install SKILL (chain claude + codex + warp)",
        hint: "self install",
      },
      {
        id: "mcp:add",
        category: "mcp",
        label: "Register new MCP connection",
        hint: "a in MCP tab",
      },
      {
        id: "self:mcp-cli",
        category: "mcp",
        label: "Open MCP wizard (CLI)",
        hint: "self mcp",
      },
      { id: "project-init", category: "project", label: "Initialize as single-repo" },
      { id: "hub-init", category: "project", label: "Initialize as hub (multi-repo)" },
      {
        id: "self:doctor",
        category: "self",
        label: "Diagnose runtime (doctor)",
        hint: "self doctor",
      },
      {
        id: "self:update",
        category: "self",
        label: "Check for update",
        hint: "self update",
      },
      {
        id: "self:help",
        category: "self",
        label: "View full CLI help",
        hint: "--help",
      },
      { id: "quit", category: "self", label: "Quit", hint: "q" },
    ],
    [],
  );

  const filteredCommands = useMemo(() => {
    const q = paletteFilter.trim().toLowerCase();
    if (!q) return allCommands;
    return allCommands.filter(
      (c) =>
        c.label.toLowerCase().includes(q) ||
        c.id.toLowerCase().includes(q) ||
        c.category.toLowerCase().includes(q),
    );
  }, [allCommands, paletteFilter]);

  const openPalette = useCallback(() => {
    setPaletteFilter("");
    setPaletteCursor(0);
    setPaletteOpen(true);
  }, []);

  const goToTab = useCallback((target: TabId) => {
    setActiveTab(target);
    setPaletteOpen(false);
    setPaletteFilter("");
    setPaletteCursor(0);
  }, []);

  const rotateTab = useCallback((direction: 1 | -1) => {
    setActiveTab((current) => {
      const idx = TAB_ORDER.indexOf(current);
      const next = (idx + direction + TAB_ORDER.length) % TAB_ORDER.length;
      return TAB_ORDER[next] ?? current;
    });
  }, []);

  const executeCommand = useCallback(
    (cmd: PaletteCommand) => {
      runAction(cmd.id);
    },
    [runAction],
  );

  useInput(
    (input, key) => {
      if (inputLocked) return;

      // Notif keys tienen prioridad: si hay notifs activas, `x` dismiss el top
      // y las teclas de action (i/r/o/d/…) disparan la acción del item más
      // nuevo que las tenga. Así `i` no se inserta al filter de palette cuando
      // hay update notif activa.
      if (notifications.length > 0 && !key.ctrl && !key.meta) {
        if (input === "x" || input === "X") {
          if (dismissTop()) return;
        } else if (input) {
          if (triggerAction(input)) return;
        }
      }

      if (paletteOpen) {
        // Tab / Shift+Tab rotan la tab activa de fondo sin cerrar la palette.
        // El TabBar refleja el cambio al instante; al cerrar palette (esc o
        // selección), el tab destino ya queda elegido.
        if (key.tab) {
          rotateTab(key.shift ? -1 : 1);
          return;
        }
        if (key.escape) {
          if (paletteFilter !== "") {
            setPaletteFilter("");
            setPaletteCursor(0);
            return;
          }
          setPaletteOpen(false);
          return;
        }
        if (key.return) {
          const cmd = filteredCommands[paletteCursor];
          if (cmd) executeCommand(cmd);
          return;
        }
        if (key.upArrow) {
          setPaletteCursor((c) => Math.max(0, c - 1));
          return;
        }
        if (key.downArrow) {
          setPaletteCursor((c) => Math.min(Math.max(0, filteredCommands.length - 1), c + 1));
          return;
        }
        if (key.backspace || key.delete) {
          setPaletteFilter((s) => s.slice(0, -1));
          setPaletteCursor(0);
          return;
        }
        // Shortcuts directos `1`–`5` desde la palette sin necesidad de filtrar
        // y `⏎`. Conveniencia para users que ya saben los atajos.
        const directTarget = TAB_BY_KEY[input];
        if (directTarget && !key.ctrl && !key.meta) {
          goToTab(directTarget);
          return;
        }
        if (input === "q" && !key.ctrl && !key.meta && paletteFilter === "") {
          onResult({ kind: "exit", exitCode: 0 });
          exit();
          return;
        }
        if (input && !key.ctrl && !key.meta) {
          setPaletteFilter((s) => s + input);
          setPaletteCursor(0);
        }
        return;
      }

      // Estamos en un tab.
      if ((key.ctrl || key.meta) && (input === "k" || input === "K")) {
        openPalette();
        return;
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
        <HomeHeader brand="agent-workflow" version={version} workspaceContext={workspaceCtx} />
        <NotificationStack items={notifications} />
        {paletteOpen ? (
          <Box flexDirection="column" flexGrow={1}>
            <CommandPalette
              filter={paletteFilter}
              commands={filteredCommands}
              cursor={paletteCursor}
            />
          </Box>
        ) : (
          <>
            <TabBar activeTabId={activeTab} alertsByTab={{ status: statusAlert }} />
            <Box flexDirection="column" flexGrow={1}>
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
              {activeTab === "mcp" ? (
                <McpTab ctx={ctx} isActive={true} onToast={pushToast} />
              ) : null}
              {activeTab === "skills" ? (
                <SkillsTab ctx={ctx} isActive={true} version={version} onToast={pushToast} />
              ) : null}
            </Box>
          </>
        )}
        <HomeFooter context={paletteOpen ? "palette" : "tab"} showDismiss={hasNotifs} />
      </Box>
    </ScreenFrame>
  );
}

async function detectHooksArmed(ctx: CliContext): Promise<boolean> {
  const settingsPath = `${ctx.env.homeDir()}/.claude/settings.json`;
  if (!(await ctx.fs.exists(settingsPath))) return false;
  try {
    const raw = await ctx.fs.readText(settingsPath);
    const parsed = JSON.parse(raw) as { hooks?: Record<string, unknown> };
    return Boolean(parsed.hooks && Object.keys(parsed.hooks).length > 0);
  } catch {
    return false;
  }
}

async function loadWorkspaceContext(ctx: CliContext): Promise<WorkspaceContext> {
  const cwd = ctx.env.cwd();

  // Mode + name: best-effort detection. Default agent-workflow.
  let modeLabel = "agent-workflow · single-repo";
  try {
    const aw = await ctx.fs.exists(`${cwd}/AW-PROJECT.md`).catch(() => false);
    if (aw) modeLabel = "agent-workflow · linked";
  } catch {
    // ignore
  }

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

  return { modeLabel, branchLabel, sessionsLabel };
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
