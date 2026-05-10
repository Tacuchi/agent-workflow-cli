import { Box, Text } from "ink";
import { colors, icons } from "../theme.js";

export interface TabDescriptor<T extends string> {
  id: T;
  label: string;
  badge?: string;
}

export interface TabBarProps<T extends string> {
  tabs: TabDescriptor<T>[];
  activeId: T;
}

export function TabBar<T extends string>({ tabs, activeId }: TabBarProps<T>) {
  return (
    <Box>
      {tabs.map((tab, idx) => {
        const isActive = tab.id === activeId;
        const labelText = tab.badge !== undefined ? `${tab.label} (${tab.badge})` : tab.label;
        return (
          <Box key={tab.id}>
            {idx > 0 ? <Text>{icons.tabSeparator}</Text> : null}
            {isActive ? (
              <>
                <Text color={colors.accent}>{icons.tabActiveLeft} </Text>
                <Text color={colors.fg} bold>
                  {labelText}
                </Text>
                <Text color={colors.accent}> {icons.tabActiveRight}</Text>
              </>
            ) : (
              <>
                <Text color={colors.fgMoreSubtle}> </Text>
                <Text color={colors.fgSubtle}>{labelText}</Text>
                <Text color={colors.fgMoreSubtle}> </Text>
              </>
            )}
          </Box>
        );
      })}
    </Box>
  );
}
