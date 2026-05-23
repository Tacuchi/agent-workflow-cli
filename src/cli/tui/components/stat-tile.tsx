import { Box, Text } from "ink";
import { colors, icons } from "../theme.js";

export type StatTone = "ok" | "warn" | "accent" | "dim";

export interface StatTileProps {
  label: string;
  value: string;
  sub?: string;
  tone?: StatTone;
  accent?: boolean;
  /** If truthy, renders a chevron indicating the tile is selectable. */
  clickable?: boolean;
  /** Highlights the tile when its index === active cursor in a strip. */
  active?: boolean;
}

function valueColor(tone?: StatTone, accent?: boolean): string {
  switch (tone) {
    case "ok":
      return colors.success;
    case "warn":
      return colors.warning;
    case "accent":
      return colors.accent;
    case "dim":
      return colors.fgSubtle;
    default:
      return accent ? colors.accent : colors.fgBright;
  }
}

export function StatTile({
  label,
  value,
  sub,
  tone,
  accent = false,
  clickable = false,
  active = false,
}: StatTileProps) {
  const borderColor = active ? colors.accent : accent ? colors.borderActive : colors.border;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={borderColor}
      paddingX={1}
      marginRight={1}
      flexGrow={1}
    >
      <Box flexDirection="row" justifyContent="space-between">
        <Text color={colors.fgSubtle}>{label.toUpperCase()}</Text>
        {clickable ? (
          <Text color={active ? colors.accent : colors.fgSubtle}>{icons.chevron}</Text>
        ) : null}
      </Box>
      <Text color={valueColor(tone, accent)} bold>
        {value}
      </Text>
      {sub ? <Text color={colors.fgSubtle}>{sub}</Text> : null}
    </Box>
  );
}
