import { Box, Text } from "ink";
import { colors } from "../theme.js";

export interface KeymapEntry {
  key: string;
  action: string;
  /** Si true, el key se renderiza en accent bold (para Ctrl+K, Enter, etc) */
  accent?: boolean;
}

export interface KeymapBarProps {
  entries: KeymapEntry[];
}

/**
 * KeymapBar — footer minimal con los atajos del tab activo.
 *
 * Una sola línea: `key label · key label · …`. Sin palette hint a la derecha
 * (la entry de Ctrl+K va en la lista normal cuando aplica).
 */
export function KeymapBar({ entries }: KeymapBarProps) {
  return (
    <Box marginTop={1}>
      {entries.map((entry, idx) => (
        <Box key={`${entry.key}-${entry.action}`}>
          {idx > 0 ? <Text color={colors.fgFaint}> · </Text> : null}
          <Text
            color={entry.accent ? colors.accent : colors.fgSubtle}
            {...(entry.accent ? { bold: true } : {})}
          >
            {entry.key}
          </Text>
          <Text color={colors.fgMoreSubtle}> {entry.action}</Text>
        </Box>
      ))}
    </Box>
  );
}
