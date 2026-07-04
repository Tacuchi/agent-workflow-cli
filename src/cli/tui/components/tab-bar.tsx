import { Box, Text } from "ink";
import { colors } from "../theme.js";
import { TABS_LIST, type TabConfig, type TabId } from "./tabs-config.js";

export interface TabBarProps {
  /** Currently active tab; null when on the palette home. */
  activeTabId: TabId | null;
  /** Override of the tab list (default TABS_LIST). */
  tabs?: readonly TabConfig[];
}

/**
 * TabBar — horizontal row with the accessible tabs.
 *
 * Layout: `<Status>  <Workflow>  <Project>  <MCP>  <Skills>`
 *
 * Active: inverse violet highlight (CTA pill style).
 * Inactive: `dim`.
 */
export function TabBar({ activeTabId, tabs = TABS_LIST }: TabBarProps) {
  return (
    <Box flexDirection="row" borderStyle="single" borderColor={colors.accent} paddingX={2}>
      {tabs.map((tab, idx) => {
        const isActive = tab.id === activeTabId;
        const isLast = idx === tabs.length - 1;
        return (
          <Box key={tab.id} marginRight={isLast ? 0 : 2}>
            {isActive ? (
              <Text color={colors.accent} bold inverse>
                {` ${tab.label} `}
              </Text>
            ) : (
              <Text color={colors.dim}>{tab.label}</Text>
            )}
          </Box>
        );
      })}
    </Box>
  );
}
