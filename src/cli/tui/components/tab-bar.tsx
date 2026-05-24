import { Box, Text } from "ink";
import { colors } from "../theme.js";
import { TABS_LIST, type TabConfig, type TabId } from "./tabs-config.js";

export interface TabBarProps {
  /** Tab activa actualmente; null cuando estamos en la palette home. */
  activeTabId: TabId | null;
  /** Map id → alert flag (dibuja ● accent al lado del label). */
  alertsByTab?: Partial<Record<TabId, boolean>>;
  /** Override de la lista de tabs (default TABS_LIST). */
  tabs?: readonly TabConfig[];
}

/**
 * TabBar — fila horizontal con la lista de tabs accesibles.
 *
 * Layout: `<Status●>  <Workflow>  <Project>  <MCP>  <Skills>`
 *
 * Activa: `bright bold` + underline.
 * Inactiva: `dim`.
 * Cada tab con `alertsByTab[id]` true muestra `●` accent inmediatamente
 * después del label.
 */
export function TabBar({ activeTabId, alertsByTab, tabs = TABS_LIST }: TabBarProps) {
  return (
    <Box flexDirection="row" marginBottom={1}>
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        const hasAlert = alertsByTab?.[tab.id] === true;
        return (
          <Box key={tab.id} marginRight={2}>
            <Text
              color={isActive ? colors.bright : colors.dim}
              bold={isActive}
              underline={isActive}
            >
              {tab.label}
            </Text>
            {hasAlert ? <Text color={colors.err}>●</Text> : null}
          </Box>
        );
      })}
    </Box>
  );
}
