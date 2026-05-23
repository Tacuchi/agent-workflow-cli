import { Box, useApp, useInput } from "ink";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ExitCode } from "../../domain/types.js";
import type { MenuAction } from "../interactive-menu.js";
import type { CliContext } from "../types.js";
import type { ActivityEvent } from "./components/activity-feed.js";
import { CommandPalette, type PaletteCommand } from "./components/command-palette.js";
import { ScreenFrame } from "./components/screen-frame.js";
import {
  Sidebar,
  type SidebarTab,
  type SidebarTabId,
  type WorkspaceContext,
} from "./components/sidebar.js";
import { ToastStack, useToasts } from "./components/toast-stack.js";
import { loadActivity } from "./data/activity.js";
import { InputLockProvider, useInputLock } from "./input-lock.js";
import { McpTab } from "./tabs/mcp-tab.js";
import { ProjectTab } from "./tabs/project-tab.js";
import { SkillsTab } from "./tabs/skills-tab.js";
import { StatusTab } from "./tabs/status-tab.js";
import { WorkflowTab } from "./tabs/workflow-tab.js";
import { type Density, TuiPrefsService } from "./tui-prefs.js";

export type TuiResult =
  | { kind: "menu-action"; action: MenuAction }
  | { kind: "exit"; exitCode: ExitCode };

type TabId = SidebarTabId;

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
      <AppShell {...props} />
    </InputLockProvider>
  );
}

function AppShell({ version, ctx, onResult }: AppProps) {
  const [activeTab, setActiveTab] = useState<TabId>("status");
  const [density, setDensity] = useState<Density>("comfortable");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteFilter, setPaletteFilter] = useState("");
  const [paletteCursor, setPaletteCursor] = useState(0);
  const [statusAlert, setStatusAlert] = useState(false);
  const [workspaceCtx, setWorkspaceCtx] = useState<WorkspaceContext>({
    modeLabel: "agent-workflow",
    branchLabel: "— · loading",
    sessionsLabel: "— sessions",
  });
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [activePhase, setActivePhase] = useState<number>(0);
  const { exit } = useApp();
  const { locked: inputLocked } = useInputLock();
  const { toasts, push: pushToast } = useToasts();

  const prefsSvc = useMemo(() => new TuiPrefsService(ctx.fs, ctx.paths), [ctx.fs, ctx.paths]);

  useEffect(() => {
    void (async () => {
      const prefs = await prefsSvc.load();
      setDensity(prefs.density);
    })();
  }, [prefsSvc]);

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

  const allCommands: PaletteCommand[] = useMemo(
    () => [
      { id: "goto:status", category: "tabs", label: "Go to Status", hint: "1" },
      { id: "goto:workflow", category: "tabs", label: "Go to Workflow", hint: "2" },
      { id: "goto:project", category: "tabs", label: "Go to Project", hint: "3" },
      { id: "goto:mcp", category: "tabs", label: "Go to MCP", hint: "4" },
      { id: "goto:skills", category: "tabs", label: "Go to Skills", hint: "5" },
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

  const closePalette = useCallback(() => {
    setPaletteOpen(false);
  }, []);

  const executeCommand = useCallback(
    (cmd: PaletteCommand) => {
      closePalette();
      if (cmd.id.startsWith("goto:")) {
        const target = cmd.id.slice("goto:".length) as TabId;
        if (TAB_ORDER.includes(target)) setActiveTab(target);
        return;
      }
      runAction(cmd.id);
    },
    [closePalette, runAction],
  );

  useInput(
    (input, key) => {
      if (inputLocked) return;

      if (paletteOpen) {
        if (key.escape) {
          closePalette();
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
        if (input && !key.ctrl && !key.meta) {
          setPaletteFilter((s) => s + input);
          setPaletteCursor(0);
        }
        return;
      }

      if ((key.ctrl || key.meta) && (input === "k" || input === "K")) {
        openPalette();
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

  const tabs: SidebarTab[] = [
    { id: "status", key: "1", label: "Status", alert: statusAlert },
    { id: "workflow", key: "2", label: "Workflow" },
    { id: "project", key: "3", label: "Project" },
    { id: "mcp", key: "4", label: "MCP" },
    { id: "skills", key: "5", label: "Skills" },
  ];

  const globalKeys = [
    { key: "^K", action: "palette" },
    { key: "⏎", action: "open" },
    { key: "↑↓", action: "navigate" },
    { key: "?", action: "help" },
    { key: "q", action: "quit" },
  ];

  return (
    <ScreenFrame>
      <Box flexDirection="row">
        <Sidebar
          activeTab={activeTab}
          tabs={tabs}
          workspaceContext={workspaceCtx}
          cliVersion={version}
          globalKeys={globalKeys}
        />
        <Box
          flexDirection="column"
          flexGrow={1}
          marginTop={density === "compact" ? 0 : 1}
          paddingX={1}
        >
          {paletteOpen ? (
            <Box flexDirection="column" alignItems="center" paddingY={2}>
              <Box width="80%" flexDirection="column">
                <CommandPalette
                  filter={paletteFilter}
                  commands={filteredCommands}
                  cursor={paletteCursor}
                />
              </Box>
            </Box>
          ) : (
            <>
              {activeTab === "status" ? (
                <StatusTab
                  ctx={ctx}
                  version={version}
                  isActive={true}
                  onActivateTab={(t) => setActiveTab(t)}
                  onRequestUpdate={() => {
                    onResult({ kind: "menu-action", action: "update" });
                    exit();
                  }}
                  onToast={pushToast}
                  onAlertChange={setStatusAlert}
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
            </>
          )}
        </Box>
      </Box>
      <ToastStack toasts={toasts} />
    </ScreenFrame>
  );
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
