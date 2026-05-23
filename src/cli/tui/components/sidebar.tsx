import { Box, Text } from "ink";
import { colors, icons } from "../theme.js";

export type SidebarTabId = "status" | "workflow" | "project" | "mcp" | "skills";

export interface SidebarTab {
  id: SidebarTabId;
  key: string;
  label: string;
  badge?: string;
  alert?: boolean;
}

export interface WorkspaceContext {
  modeLabel: string;
  branchLabel: string;
  sessionsLabel: string;
}

export interface KeymapEntry {
  key: string;
  action: string;
}

export interface SidebarProps {
  activeTab: SidebarTabId;
  tabs: SidebarTab[];
  workspaceContext: WorkspaceContext;
  cliVersion: string;
  globalKeys: KeymapEntry[];
  width?: number;
}

const DEFAULT_WIDTH = 24;
// Reservado para alinear los `entry.action` en la columna de keymap. 3 cells es
// suficiente para los keys más anchos (`↑↓`, `^K`).
const KEY_COL_WIDTH = 4;

export function Sidebar({
  activeTab,
  tabs,
  workspaceContext,
  cliVersion,
  globalKeys,
  width = DEFAULT_WIDTH,
}: SidebarProps) {
  return (
    <Box
      flexDirection="column"
      width={width}
      flexShrink={0}
      paddingX={1}
      paddingY={1}
    >
      {/* Brand block — separación interna entre brand y version + divisor abajo */}
      <Box flexDirection="column">
        <Text wrap="truncate-end">
          <Text color={colors.accent} bold>
            {icons.brand}
          </Text>
          <Text color={colors.bright} bold>
            {" "}
            agent-workflow
          </Text>
        </Text>
        <Text color={colors.faint} wrap="truncate-end">
          v{cliVersion} · @tacuchi
        </Text>
      </Box>

      <Box marginTop={1}>
        <Divider />
      </Box>

      {/* Tabs */}
      <Box marginTop={1} flexDirection="column">
        {tabs.map((tab) => (
          <SidebarTabRow key={tab.id} tab={tab} active={tab.id === activeTab} />
        ))}
      </Box>

      <Box marginTop={1}>
        <Divider />
      </Box>

      {/* Workspace context — wrap="truncate-end" para evitar wraps awkward */}
      <Box marginTop={1} flexDirection="column">
        <Text color={colors.mute}>WORKSPACE</Text>
        <Text color={colors.text} wrap="truncate-end">
          {workspaceContext.modeLabel}
        </Text>
        <Text color={colors.dim} wrap="truncate-end">
          {workspaceContext.branchLabel}
        </Text>
        <Text color={colors.dim} wrap="truncate-end">
          {workspaceContext.sessionsLabel}
        </Text>
      </Box>

      <Box marginTop={1}>
        <Divider />
      </Box>

      {/* Keymap global con columna alineada para los keys */}
      <Box marginTop={1} flexDirection="column">
        {globalKeys.map((entry) => (
          <Box key={`${entry.key}-${entry.action}`}>
            <Box width={KEY_COL_WIDTH}>
              <Text color={colors.accent}>{entry.key}</Text>
            </Box>
            <Text color={colors.dim}>{entry.action}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

// Width interior del sidebar: width - paddingX*2 = 22, menos 2 cells de safety
// margin para variabilidad de ancho visual de glyphs + inner padding.
const SIDEBAR_INNER_WIDTH = DEFAULT_WIDTH - 4;
const SIDEBAR_INNER_PAD = 1;

function SidebarTabRow({ tab, active }: { tab: SidebarTab; active: boolean }) {
  const focusGlyph = active ? icons.focusBar : " ";
  const bg = active ? colors.bgHighlight : undefined;
  const bgProp = bg ? { backgroundColor: bg } : {};
  const innerPad = " ".repeat(SIDEBAR_INNER_PAD);

  // Layout: bar + gap + inner_pad + key + space + label + ... + inner_pad.
  // Bar va AFUERA del bg; el bg empieza en inner_pad.
  const FOCUS_OUTER = 2;
  const used =
    FOCUS_OUTER +
    SIDEBAR_INNER_PAD * 2 +
    [...tab.key].length +
    1 +
    [...tab.label].length +
    (tab.badge ? [...tab.badge].length + 1 : 0) +
    (tab.alert ? 2 : 0);
  const spacerLen = Math.max(1, SIDEBAR_INNER_WIDTH - used);
  const spacer = " ".repeat(spacerLen);

  return (
    <Box flexDirection="row">
      {/* Focus bar afuera del bg */}
      <Text color={colors.accent} bold={active}>
        {focusGlyph}
      </Text>
      <Text> </Text>
      {/* bg highlight empieza acá */}
      <Text {...bgProp}>{innerPad}</Text>
      <Text {...bgProp} color={active ? colors.accent : colors.dim} bold={active}>
        {tab.key}
      </Text>
      <Text {...bgProp}> </Text>
      <Text {...bgProp} color={active ? colors.bright : colors.text} bold={active}>
        {tab.label}
      </Text>
      <Text {...bgProp} wrap="truncate-end">
        {spacer}
      </Text>
      {tab.badge ? (
        <Text {...bgProp} color={active ? colors.accentSoft : colors.mute}>
          {tab.badge}
        </Text>
      ) : null}
      {tab.alert ? (
        <>
          <Text {...bgProp}> </Text>
          <Text {...bgProp} color={colors.err}>
            ●
          </Text>
        </>
      ) : null}
      <Text {...bgProp}>{innerPad}</Text>
    </Box>
  );
}

function Divider() {
  return <Text color={colors.borderFaint}>{"─".repeat(DEFAULT_WIDTH - 2)}</Text>;
}
