import { Box, Text } from "ink";
import { colors, icons, toneColor } from "../theme.js";

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
        <Text color={toneColor(tone, accent ? colors.accent : colors.bright)} bold>
          {value}
        </Text>
        {sub ? <Text color={colors.dim}>{sub}</Text> : null}
      </Box>
    </Box>
  );
}
