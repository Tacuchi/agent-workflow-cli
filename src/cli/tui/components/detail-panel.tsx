import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { truncateCells } from "../row-width.js";
import { colors, icons, toneColor } from "../theme.js";

export type DetailTone = "ok" | "warn" | "accent" | "dim" | "err" | "purple" | "info";

export interface DetailHeader {
  /** Optional glyph prefix (e.g. ▤). If empty, header renders just the name. */
  glyph?: string;
  name: string;
  meta?: string;
}

export interface DetailStatePill {
  label: string;
  tone?: DetailTone;
}

export interface DetailAction {
  name: string;
  description?: string;
  danger?: boolean;
}

interface DetailFooterEntry {
  key: string;
  label: string;
}

export interface DetailPanelProps {
  header: DetailHeader;
  statePill?: DetailStatePill;
  actions: DetailAction[];
  focusedAction: number;
  /** If present, the actions block is replaced by this banner (e.g. ConfirmBanner). */
  banner?: ReactNode;
  /**
   * Draws a frame (rounded border) around the panel. The frame is added
   * OUTSIDE the content width (does not shrink it), so the internal
   * calculations stay the same; the tab row accounts for it via
   * {@link DETAIL_PANEL_ROW_OVERHEAD}.
   */
  bordered?: boolean;
}

const DEFAULT_WIDTH = 38;
/** Cells added by the frame (1 per side) when `bordered`. */
const BORDER_WIDTH = 2;
/**
 * Width the panel occupies in the tab row when open: content + frame + 1 of
 * gap from the list. Consumed by `rowWidth()` so the list does not overlap
 * the panel. Lives here, next to the panel's real width, so they cannot
 * desync (if the width/frame changes, the overhead follows).
 */
export const DETAIL_PANEL_ROW_OVERHEAD = DEFAULT_WIDTH + BORDER_WIDTH + 1;
const DEFAULT_FOOTER: DetailFooterEntry[] = [
  { key: "⏎", label: "apply" },
  { key: "↑↓", label: "action" },
  { key: "esc", label: "close" },
];

// Separator between name and description on the same line.
const NAME_DESC_SEP = " · ";

export function DetailPanel({
  header,
  statePill,
  actions,
  focusedAction,
  banner,
  bordered = false,
}: DetailPanelProps) {
  // The frame is added outside (outerWidth = width + frame) so the content is
  // not shrunk: internal calculations (separator, action rows) keep using the width.
  return (
    <Box
      flexDirection="column"
      width={bordered ? DEFAULT_WIDTH + BORDER_WIDTH : DEFAULT_WIDTH}
      paddingLeft={1}
      borderStyle={bordered ? "round" : undefined}
      borderColor={bordered ? colors.border : undefined}
    >
      <Box flexDirection="row">
        {header.glyph ? (
          <>
            <Text color={colors.accent}>{header.glyph}</Text>
            <Text> </Text>
          </>
        ) : null}
        <Text color={colors.bright} bold>
          {header.name}
        </Text>
        <Box flexGrow={1} />
        {statePill ? <Text color={toneColor(statePill.tone)}>{statePill.label}</Text> : null}
      </Box>
      {header.meta ? (
        <Box>
          <Text color={colors.dim}>{header.meta}</Text>
        </Box>
      ) : null}

      <Box marginTop={1} flexDirection="column">
        {banner ? (
          banner
        ) : (
          <>
            <Text color={colors.mute}>ACTIONS</Text>
            <Box flexDirection="column" marginTop={0}>
              {actions.map((a, i) => (
                <DetailActionRow key={a.name} action={a} focused={i === focusedAction} />
              ))}
            </Box>
          </>
        )}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color={colors.borderFaint}>{"─".repeat(DEFAULT_WIDTH - 2)}</Text>
        <DetailFooter entries={DEFAULT_FOOTER} />
      </Box>
    </Box>
  );
}

// Inner width of the detail panel: DEFAULT_WIDTH - paddingLeft - safety.
const DETAIL_INNER_WIDTH = DEFAULT_WIDTH - 3;
const ACTION_INNER_PAD = 1;

function DetailActionRow({
  action,
  focused,
}: {
  action: DetailAction;
  focused: boolean;
}) {
  const nameColor = focused
    ? action.danger
      ? colors.err
      : colors.bright
    : action.danger
      ? colors.err
      : colors.text;
  const descColor = focused
    ? action.danger
      ? colors.err
      : colors.accentSoft
    : action.danger
      ? colors.faint
      : colors.dim;
  const focusBarColor = focused ? (action.danger ? colors.err : colors.accent) : colors.faint;
  const bg = focused ? colors.bgHighlight : undefined;
  const bgProp = bg ? { backgroundColor: bg } : {};
  const innerPad = " ".repeat(ACTION_INNER_PAD);

  // 1-line layout: bar + gap + pad + name + sep + desc + spacer + pad.
  // The focus bar sits OUTSIDE the bg (like list-row); bg starts at the inner pad.
  const FOCUS_OUTER = 2; // bar + gap
  const nameLen = [...action.name].length;
  const sepLen = action.description ? NAME_DESC_SEP.length : 0;
  const fixedLen = FOCUS_OUTER + ACTION_INNER_PAD * 2 + nameLen;
  const availableForDesc = Math.max(
    0,
    DETAIL_INNER_WIDTH - fixedLen - sepLen - 1, // -1 reserves the min spacer
  );

  const displayDesc = truncateCells(action.description ?? "", availableForDesc);

  const descLen = displayDesc ? [...displayDesc].length : 0;
  const sepActualLen = displayDesc ? sepLen : 0;
  const usedLen = fixedLen + sepActualLen + descLen;
  const spacerLen = Math.max(1, DETAIL_INNER_WIDTH - usedLen);
  const spacer = " ".repeat(spacerLen);

  return (
    <Box flexDirection="row" marginTop={0}>
      {/* Focus bar OUTSIDE the bg — independent bar */}
      <Text color={focusBarColor} bold={focused}>
        {focused ? icons.focusBar : " "}
      </Text>
      <Text> </Text>
      {/* bg highlight starts here */}
      <Text {...bgProp}>{innerPad}</Text>
      <Text {...bgProp} color={nameColor} bold={focused}>
        {action.name}
      </Text>
      {displayDesc ? (
        <>
          <Text {...bgProp} color={colors.dim}>
            {NAME_DESC_SEP}
          </Text>
          <Text {...bgProp} color={descColor} wrap="truncate-end">
            {displayDesc}
          </Text>
        </>
      ) : null}
      <Text {...bgProp} wrap="truncate-end">
        {spacer}
      </Text>
      <Text {...bgProp}>{innerPad}</Text>
    </Box>
  );
}

function DetailFooter({ entries }: { entries: DetailFooterEntry[] }) {
  return (
    <Box flexDirection="row">
      {entries.map((e, i) => (
        <Box key={`${e.key}-${e.label}`} marginRight={i < entries.length - 1 ? 3 : 0}>
          <Text color={colors.accent}>{e.key}</Text>
          <Text color={colors.faint}> {e.label}</Text>
        </Box>
      ))}
    </Box>
  );
}
