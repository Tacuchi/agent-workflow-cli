import { Box, useApp, useInput } from "ink";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ExitCode } from "../../domain/types.js";
import type { MenuAction } from "../interactive-menu.js";
import type { CliContext } from "../types.js";
import { Header } from "./components/header.js";
import { KeymapBar, type KeymapEntry } from "./components/keymap-bar.js";
import { ScreenFrame } from "./components/screen-frame.js";
import { TabBar, type TabDescriptor } from "./components/tab-bar.js";
import { ToastStack, useToasts } from "./components/toast-stack.js";
import { InputLockProvider, useInputLock } from "./input-lock.js";
import { McpTab } from "./tabs/mcp-tab.js";
import { PluginsTab } from "./tabs/plugins-tab.js";
import { ProjectTab } from "./tabs/project-tab.js";
import { SkillsTab } from "./tabs/skills-tab.js";
import { StatusTab } from "./tabs/status-tab.js";
import { UpdateTab } from "./tabs/update-tab.js";
import { type Density, TuiPrefsService } from "./tui-prefs.js";

export type TuiResult =
  | { kind: "menu-action"; action: MenuAction }
  | { kind: "exit"; exitCode: ExitCode };

type TabId = "status" | "project" | "mcp" | "skills" | "plugins" | "update";

const TAB_ORDER: readonly TabId[] = [
  "status",
  "project",
  "mcp",
  "skills",
  "plugins",
  "update",
] as const;

// Atajo numérico → tab id.
const TAB_BY_KEY: Record<string, TabId> = {
  "1": "status",
  "2": "project",
  "3": "mcp",
  "4": "skills",
  "5": "plugins",
  "6": "update",
};

const QUIT_HINT: KeymapEntry = { key: "q", action: "salir" };
const TAB_HINT: KeymapEntry = { key: "Tab", action: "siguiente" };

const KEYS_BY_TAB: Record<TabId, KeymapEntry[]> = {
  status: [TAB_HINT, QUIT_HINT],
  project: [
    { key: "↑↓", action: "navegar" },
    { key: "⏎", action: "aplicar", accent: true },
    QUIT_HINT,
  ],
  mcp: [
    { key: "↑↓", action: "navegar" },
    { key: "⏎", action: "acciones", accent: true },
    QUIT_HINT,
  ],
  skills: [
    { key: "↑↓", action: "navegar" },
    { key: "⏎", action: "acciones", accent: true },
    QUIT_HINT,
  ],
  plugins: [
    { key: "↑↓", action: "navegar" },
    { key: "/", action: "buscar" },
    { key: "f", action: "filtros" },
    QUIT_HINT,
  ],
  update: [
    { key: "i", action: "aplicar", accent: true },
    { key: "r", action: "buscar" },
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
   * Despacha acciones provenientes de las tabs (Proyecto landing, Update, etc).
   * Las acciones que requieren ejecutar un comando CLI con stdin (init, update)
   * salen del TUI primero y se manejan en `dispatchMenuAction` del main.
   */
  const runAction = useCallback(
    (id: string, _payload?: Record<string, unknown>) => {
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
      if (id === "quit") {
        onResult({ kind: "exit", exitCode: 0 });
        exit();
        return;
      }
      if (id === "git:status") {
        pushToast({
          tone: "info",
          title: "git status",
          body: "Abrí tu terminal para ver el detalle.",
        });
        return;
      }
      pushToast({ tone: "info", title: id });
    },
    [pushToast, onResult, exit],
  );

  useInput(
    (input, key) => {
      if (inputLocked) return;
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
    { id: "status", label: "Status", key: "1" },
    { id: "project", label: "Proyecto", key: "2" },
    { id: "mcp", label: "MCP", key: "3" },
    { id: "skills", label: "Skills", key: "4" },
    { id: "plugins", label: "Plugins", key: "5" },
    { id: "update", label: "Update", key: "6", alert: true },
  ];

  const keymap = KEYS_BY_TAB[activeTab] ?? [];

  return (
    <ScreenFrame>
      <Header version={version} cwd={ctx.env.cwd()} homeDir={ctx.env.homeDir()} />
      <TabBar tabs={tabs} activeId={activeTab} />
      <Box marginTop={density === "compact" ? 0 : 1} flexDirection="column">
        {activeTab === "status" ? <StatusTab ctx={ctx} isActive={true} /> : null}
        {activeTab === "project" ? (
          <ProjectTab ctx={ctx} isActive={true} onRunAction={runAction} />
        ) : null}
        {activeTab === "mcp" ? <McpTab ctx={ctx} isActive={true} onToast={pushToast} /> : null}
        {activeTab === "skills" ? (
          <SkillsTab ctx={ctx} isActive={true} onToast={pushToast} />
        ) : null}
        {activeTab === "update" ? (
          <UpdateTab
            ctx={ctx}
            version={version}
            isActive={true}
            onToast={pushToast}
            onRequestUpdate={() => {
              onResult({ kind: "menu-action", action: "update" });
              exit();
            }}
          />
        ) : null}
        {activeTab === "plugins" ? <PluginsTab ctx={ctx} isActive={true} /> : null}
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
