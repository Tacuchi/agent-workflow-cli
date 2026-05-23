import { Box, Text } from "ink";
import { colors, icons } from "../theme.js";

export type StatTone = "ok" | "warn" | "accent" | "dim" | "err";

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
  /** If true, aligns the tile to the right (used for WORKING TREE). */
  alignRight?: boolean;
}

function valueColor(tone?: StatTone, accent?: boolean): string {
  switch (tone) {
    case "ok":
      return colors.ok;
    case "warn":
      return colors.warn;
    case "err":
      return colors.err;
    case "accent":
      return colors.accent;
    case "dim":
      return colors.dim;
    default:
      return accent ? colors.accent : colors.bright;
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
  alignRight = false,
}: StatTileProps) {
  return (
    <Box flexDirection="row" marginRight={alignRight ? 0 : 2} flexGrow={alignRight ? 0 : 1}>
      <Text color={active ? colors.accent : colors.faint}>{active ? icons.focusBar : " "}</Text>
      <Box flexDirection="column" paddingLeft={active ? 1 : 0}>
        <Box flexDirection="row">
          <Text color={colors.mute}>{label.toUpperCase()}</Text>
          {clickable ? (
            <>
              <Text> </Text>
              <Text color={active ? colors.accent : colors.faint}>{icons.chevron}</Text>
            </>
          ) : null}
        </Box>
        <Text color={valueColor(tone, accent)} bold>
          {value}
        </Text>
        {sub ? <Text color={colors.dim}>{sub}</Text> : null}
      </Box>
    </Box>
  );
}
