import { Box, Text } from "ink";
import { colors } from "../theme.js";
import { TABS_LIST, type TabConfig, type TabId } from "./tabs-config.js";

export interface TabBarProps {
  /** Tab activa actualmente; null cuando estamos en la palette home. */
  activeTabId: TabId | null;
  /** Override de la lista de tabs (default TABS_LIST). */
  tabs?: readonly TabConfig[];
}

/**
 * TabBar — fila horizontal con la lista de tabs accesibles.
 *
 * Layout: `<Status>  <Workflow>  <Project>  <MCP>  <Skills>`
 *
 * Activa: highlight inverse violet (estilo CTA pill).
 * Inactiva: `dim`.
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
