import { Box, Text, useApp, useInput } from "ink";
import { useMemo, useState } from "react";
import type { ExitCode } from "../../domain/types.js";
import type { MenuAction } from "../interactive-menu.js";
import type { CliContext } from "../types.js";
import { Header } from "./components/header.js";
import { KeymapBar, type KeymapEntry } from "./components/keymap-bar.js";
import { ScreenFrame } from "./components/screen-frame.js";
import { TabBar, type TabDescriptor } from "./components/tab-bar.js";
import { InputLockProvider, useInputLock } from "./input-lock.js";
import { McpTab } from "./tabs/mcp-tab.js";
import { PluginsTab } from "./tabs/plugins-tab.js";
import { SkillsTab } from "./tabs/skills-tab.js";
import { StatusTab } from "./tabs/status-tab.js";
import { UpdateTab } from "./tabs/update-tab.js";
import { colors } from "./theme.js";

export type TuiResult =
  | { kind: "menu-action"; action: MenuAction }
  | { kind: "exit"; exitCode: ExitCode };

type TabId = "status" | "mcp" | "skills" | "plugins" | "update";

const TAB_ORDER: readonly TabId[] = ["status", "mcp", "skills", "plugins", "update"] as const;

const TABS: TabDescriptor<TabId>[] = [
  { id: "status", label: "Status" },
  { id: "mcp", label: "MCP" },
  { id: "skills", label: "Skills" },
  { id: "plugins", label: "Warp Plugins" },
  { id: "update", label: "Update" },
];

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
  const [helpOpen, setHelpOpen] = useState(false);
  const { exit } = useApp();
  const { locked: inputLocked } = useInputLock();

  useInput(
    (input, key) => {
      if (helpOpen) {
        handleHelpKey(input, key, setHelpOpen);
        return;
      }
      handleAppKey(input, key, {
        setActiveTab,
        setHelpOpen,
        onExit: () => {
          onResult({ kind: "exit", exitCode: 0 });
          exit();
        },
      });
    },
    { isActive: !inputLocked },
  );

  const keymap: KeymapEntry[] = useMemo(() => {
    if (inputLocked) {
      return [
        { key: "⏎", action: "aceptar" },
        { key: "Esc", action: "cancelar" },
      ];
    }
    const tabKeys = keymapForTab(activeTab);
    return [
      ...tabKeys,
      { key: "Tab", action: "cambiar tab" },
      { key: "?", action: "ayuda" },
      { key: "q", action: "salir" },
    ];
  }, [activeTab, inputLocked]);

  const tabContentActive = !helpOpen;

  return (
    <ScreenFrame>
      <Header version={version} cwd={ctx.env.cwd()} homeDir={ctx.env.homeDir()} />
      <TabBar tabs={TABS} activeId={activeTab} />
      <Box marginTop={1} flexDirection="column">
        {activeTab === "status" ? <StatusTab ctx={ctx} isActive={tabContentActive} /> : null}
        {activeTab === "mcp" ? <McpTab ctx={ctx} isActive={tabContentActive} /> : null}
        {activeTab === "skills" ? <SkillsTab ctx={ctx} isActive={tabContentActive} /> : null}
        {activeTab === "update" ? (
          <UpdateTab
            ctx={ctx}
            version={version}
            isActive={tabContentActive}
            onRequestUpdate={() => {
              onResult({ kind: "menu-action", action: "update" });
              exit();
            }}
          />
        ) : null}
        {activeTab === "plugins" ? <PluginsTab ctx={ctx} isActive={tabContentActive} /> : null}
      </Box>
      {helpOpen ? <HelpOverlay /> : <KeymapBar entries={keymap} />}
    </ScreenFrame>
  );
}

type AppKeyHandlers = {
  setActiveTab: (next: TabId | ((prev: TabId) => TabId)) => void;
  setHelpOpen: (open: boolean) => void;
  onExit: () => void;
};

function handleHelpKey(
  input: string,
  key: { escape?: boolean },
  setHelpOpen: (open: boolean) => void,
): void {
  if (key.escape || input === "?" || input === "q" || input === "Q") {
    setHelpOpen(false);
  }
}

function handleAppKey(
  input: string,
  key: { tab?: boolean; shift?: boolean },
  handlers: AppKeyHandlers,
): void {
  if (input === "q" || input === "Q") {
    handlers.onExit();
    return;
  }
  if (input === "?") {
    handlers.setHelpOpen(true);
    return;
  }
  if (key.tab) {
    handlers.setActiveTab((t) => cycleTab(t, key.shift === true));
    return;
  }
  const byNumber: Record<string, TabId | undefined> = {
    "1": "status",
    "2": "mcp",
    "3": "skills",
    "4": "plugins",
    "5": "update",
  };
  const target = byNumber[input];
  if (target) handlers.setActiveTab(target);
}

function cycleTab(current: TabId, reverse: boolean): TabId {
  const idx = TAB_ORDER.indexOf(current);
  const next = reverse
    ? (idx - 1 + TAB_ORDER.length) % TAB_ORDER.length
    : (idx + 1) % TAB_ORDER.length;
  return TAB_ORDER[next] ?? "status";
}

function keymapForTab(tab: TabId): KeymapEntry[] {
  switch (tab) {
    case "mcp":
      return [
        { key: "↑↓", action: "navegar" },
        { key: "⏎", action: "acciones" },
        { key: "n", action: "nueva" },
      ];
    case "skills":
      return [
        { key: "↑↓", action: "navegar" },
        { key: "⏎", action: "acciones" },
      ];
    case "update":
      return [
        { key: "↑↓", action: "navegar" },
        { key: "⏎", action: "seleccionar" },
      ];
    case "plugins":
      return [
        { key: "↑↓", action: "navegar" },
        { key: "⏎", action: "acciones" },
        { key: "n", action: "nuevo" },
      ];
    case "status":
      return [];
  }
}

function HelpOverlay() {
  return (
    <Box
      flexDirection="column"
      marginTop={1}
      borderStyle="round"
      borderColor={colors.accent}
      paddingX={2}
      paddingY={1}
    >
      <Text color={colors.fg} bold>
        Ayuda
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Help label="Tab / ⇧Tab" desc="cambiar tab" />
        <Help label="1 .. 5" desc="ir a tab por número" />
        <Help label="?" desc="abrir/cerrar esta ayuda" />
        <Help label="q" desc="salir del TUI" />
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color={colors.fgSubtle} bold>
          MCP
        </Text>
        <Help label="↑↓" desc="navegar conexiones" />
        <Help label="⏎" desc="abrir menú de acciones de la conexión" />
        <Help label="↑↓ ⏎" desc="navegar el menú y aplicar" />
        <Help label="Esc" desc="cerrar menú sin aplicar" />
        <Help label="n" desc="registrar nueva conexión" />
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color={colors.fgSubtle} bold>
          Skills
        </Text>
        <Help label="↑↓" desc="navegar targets (Claude / Codex / Warp)" />
        <Help label="⏎" desc="abrir menú de acciones del target" />
        <Help label="↑↓ ⏎" desc="navegar el menú y aplicar (instalar / desinstalar)" />
        <Help label="Esc" desc="cerrar menú sin aplicar" />
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color={colors.fgSubtle} bold>
          Warp Plugins
        </Text>
        <Help label="↑↓" desc="navegar plugins" />
        <Help label="⏎" desc="abrir menú de acciones del plugin" />
        <Help label="↑↓ ⏎" desc="navegar el menú y aplicar" />
        <Help label="Esc" desc="cerrar menú sin aplicar" />
        <Help label="n" desc="agregar nuevo plugin desde URL git (menú de target)" />
      </Box>
      <Box marginTop={1}>
        <Text color={colors.fgMoreSubtle}>Esc cierra esta ventana.</Text>
      </Box>
    </Box>
  );
}

function Help({ label, desc }: { label: string; desc: string }) {
  return (
    <Box>
      <Text color={colors.accent} bold>
        {label}
      </Text>
      <Text color={colors.fgMoreSubtle}> </Text>
      <Text color={colors.fgSubtle}>{desc}</Text>
    </Box>
  );
}
