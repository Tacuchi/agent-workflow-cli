import { Box, useApp, useInput } from "ink";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ExitCode } from "../../domain/types.js";
import type { MenuAction } from "../interactive-menu.js";
import type { CliContext } from "../types.js";
import { CommandPalette, type PaletteCommand } from "./components/command-palette.js";
import { Header } from "./components/header.js";
import { KeymapBar, type KeymapEntry } from "./components/keymap-bar.js";
import { ScreenFrame } from "./components/screen-frame.js";
import { TabBar, type TabDescriptor } from "./components/tab-bar.js";
import { ToastStack, useToasts } from "./components/toast-stack.js";
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

type TabId = "status" | "workflow" | "project" | "mcp" | "skills";

const TAB_ORDER: readonly TabId[] = ["status", "workflow", "project", "mcp", "skills"] as const;

const TAB_BY_KEY: Record<string, TabId> = {
  "1": "status",
  "2": "workflow",
  "3": "project",
  "4": "mcp",
  "5": "skills",
};

const QUIT_HINT: KeymapEntry = { key: "q", action: "quit" };
const TAB_HINT: KeymapEntry = { key: "Tab", action: "next" };
const PALETTE_HINT: KeymapEntry = { key: "^K", action: "palette" };

const KEYS_BY_TAB: Record<TabId, KeymapEntry[]> = {
  status: [
    { key: "↑↓", action: "navigate" },
    { key: "⏎", action: "go to tab", accent: true },
    { key: "i", action: "apply update" },
    PALETTE_HINT,
    QUIT_HINT,
  ],
  workflow: [TAB_HINT, PALETTE_HINT, QUIT_HINT],
  project: [
    { key: "↑↓", action: "navigate" },
    { key: "⏎", action: "apply", accent: true },
    PALETTE_HINT,
    QUIT_HINT,
  ],
  mcp: [
    { key: "↑↓", action: "navigate" },
    { key: "⏎", action: "actions", accent: true },
    PALETTE_HINT,
    QUIT_HINT,
  ],
  skills: [
    { key: "↑↓", action: "navigate" },
    { key: "⏎", action: "actions", accent: true },
    PALETTE_HINT,
    QUIT_HINT,
  ],
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

  // Catálogo completo de comandos accesibles desde la palette (⌘K / Ctrl+K).
  // Categorías: tabs · install · mcp · project · self.
  const allCommands: PaletteCommand[] = useMemo(
    () => [
      // tabs
      { id: "goto:status", category: "tabs", label: "Go to Status", hint: "1" },
      { id: "goto:workflow", category: "tabs", label: "Go to Workflow", hint: "2" },
      { id: "goto:project", category: "tabs", label: "Go to Project", hint: "3" },
      { id: "goto:mcp", category: "tabs", label: "Go to MCP", hint: "4" },
      { id: "goto:skills", category: "tabs", label: "Go to Skills", hint: "5" },
      // install
      {
        id: "install-skill",
        category: "install",
        label: "Install SKILL (chain claude + codex + warp)",
        hint: "self install",
      },
      // mcp
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
      // project
      { id: "project-init", category: "project", label: "Initialize as single-repo" },
      { id: "hub-init", category: "project", label: "Initialize as hub (multi-repo)" },
      // self
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
      if (key.tab) {
        setActiveTab((t) => cycleTab(t, key.shift === true));
        return;
      }
      const target = TAB_BY_KEY[input];
      if (target) setActiveTab(target);
    },
    { isActive: true },
  );

  const tabs: TabDescriptor<TabId>[] = [
    { id: "status", label: "Status", key: "1", alert: statusAlert },
    { id: "workflow", label: "Workflow", key: "2" },
    { id: "project", label: "Project", key: "3" },
    { id: "mcp", label: "MCP", key: "4" },
    { id: "skills", label: "Skills", key: "5" },
  ];

  const keymap = paletteOpen ? [] : (KEYS_BY_TAB[activeTab] ?? []);

  return (
    <ScreenFrame>
      <Header version={version} cwd={ctx.env.cwd()} homeDir={ctx.env.homeDir()} />
      <TabBar tabs={tabs} activeId={activeTab} />
      <Box marginTop={density === "compact" ? 0 : 1} flexDirection="column">
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
              />
            ) : null}
            {activeTab === "workflow" ? <WorkflowTab ctx={ctx} isActive={true} /> : null}
            {activeTab === "project" ? (
              <ProjectTab ctx={ctx} isActive={true} onRunAction={runAction} />
            ) : null}
            {activeTab === "mcp" ? <McpTab ctx={ctx} isActive={true} onToast={pushToast} /> : null}
            {activeTab === "skills" ? (
              <SkillsTab ctx={ctx} isActive={true} version={version} onToast={pushToast} />
            ) : null}
          </>
        )}
      </Box>
      <ToastStack toasts={toasts} />
      <KeymapBar entries={keymap} />
    </ScreenFrame>
  );
}

function cycleTab(current: TabId, reverse: boolean): TabId {
  const idx = TAB_ORDER.indexOf(current);
  const next = reverse
    ? (idx - 1 + TAB_ORDER.length) % TAB_ORDER.length
    : (idx + 1) % TAB_ORDER.length;
  return TAB_ORDER[next] ?? "status";
}
