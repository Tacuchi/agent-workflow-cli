import { Box, Text } from "ink";
import { colors } from "../theme.js";

export interface TabDescriptor<T extends string> {
  id: T;
  label: string;
  /** Atajo numérico (1-6). Se renderiza dim antes del label. */
  key?: string;
  /** Texto del badge — solo se muestra cuando es relevante. */
  badge?: string;
  /** Dot alert al final del label si hay novedades. */
  alert?: boolean;
}

export interface TabBarProps<T extends string> {
  tabs: TabDescriptor<T>[];
  activeId: T;
}

/**
 * TabBar minimal — `key label` por tab.
 *
 * Active = label inverse (fondo accent + texto bg) — destaca como un chip.
 * Inactive = label mute + key faint.
 * Badge dim opcional. Alert dot rojo opcional.
 */
export function TabBar<T extends string>({ tabs, activeId }: TabBarProps<T>) {
  return (
    <Box marginBottom={1}>
      {tabs.map((tab, idx) => {
        const isActive = tab.id === activeId;
        return (
          <Box key={tab.id} marginLeft={idx === 0 ? 0 : 2}>
            {tab.key ? (
              <Text color={isActive ? colors.accent : colors.fgFaint}>{tab.key} </Text>
            ) : null}
            <Text
              color={isActive ? colors.accent : colors.fgSubtle}
              {...(isActive ? { bold: true, inverse: true } : {})}
            >
              {isActive ? ` ${tab.label} ` : tab.label}
            </Text>
            {tab.badge !== undefined ? <Text color={colors.fgFaint}> {tab.badge}</Text> : null}
            {tab.alert ? <Text color={colors.error}> •</Text> : null}
          </Box>
        );
      })}
    </Box>
  );
}
