import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { colors, icons } from "../theme.js";

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

export interface DetailFooterEntry {
  key: string;
  label: string;
}

export interface DetailPanelProps {
  width?: number;
  header: DetailHeader;
  statePill?: DetailStatePill;
  actions: DetailAction[];
  focusedAction: number;
  /** Structured footer entries with key + label. If omitted, uses default. */
  footer?: DetailFooterEntry[];
  /** If present, the actions block is replaced by this banner (e.g. ConfirmBanner). */
  banner?: ReactNode;
}

const DEFAULT_WIDTH = 38;
const DEFAULT_FOOTER: DetailFooterEntry[] = [
  { key: "⏎", label: "apply" },
  { key: "↑↓", label: "action" },
  { key: "esc", label: "close" },
];

// Separator entre name y description en la misma línea.
const NAME_DESC_SEP = " · ";

function toneColor(tone?: DetailTone): string {
  switch (tone) {
    case "ok":
      return colors.ok;
    case "warn":
      return colors.warn;
    case "accent":
      return colors.accent;
    case "err":
      return colors.err;
    case "dim":
      return colors.dim;
    case "purple":
      return colors.purple;
    case "info":
      return colors.info;
    default:
      return colors.dim;
  }
}

export function DetailPanel({
  width = DEFAULT_WIDTH,
  header,
  statePill,
  actions,
  focusedAction,
  footer = DEFAULT_FOOTER,
  banner,
}: DetailPanelProps) {
  return (
    <Box flexDirection="column" width={width} paddingLeft={1}>
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
                <DetailActionRow
                  key={a.name}
                  action={a}
                  focused={i === focusedAction}
                />
              ))}
            </Box>
          </>
        )}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color={colors.borderFaint}>{"─".repeat(width - 2)}</Text>
        <DetailFooter entries={footer} />
      </Box>
    </Box>
  );
}

// Width interior del detail panel: DEFAULT_WIDTH - paddingLeft - safety.
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
  const focusBarColor = focused
    ? action.danger
      ? colors.err
      : colors.accent
    : colors.faint;
  const bg = focused ? colors.bgHighlight : undefined;
  const bgProp = bg ? { backgroundColor: bg } : {};
  const innerPad = " ".repeat(ACTION_INNER_PAD);

  // Layout 1 línea: bar + gap + pad + name + sep + desc + spacer + pad.
  // El focus bar va AFUERA del bg (como list-row); bg empieza en el inner pad.
  const FOCUS_OUTER = 2; // bar + gap
  const nameLen = [...action.name].length;
  const sepLen = action.description ? NAME_DESC_SEP.length : 0;
  const fixedLen = FOCUS_OUTER + ACTION_INNER_PAD * 2 + nameLen;
  const availableForDesc = Math.max(
    0,
    DETAIL_INNER_WIDTH - fixedLen - sepLen - 1, // -1 reserva spacer min
  );

  let displayDesc = action.description ?? "";
  if (action.description && [...action.description].length > availableForDesc) {
    if (availableForDesc <= 1) {
      displayDesc = "";
    } else {
      displayDesc = `${action.description.slice(0, availableForDesc - 1)}…`;
    }
  }

  const descLen = displayDesc ? [...displayDesc].length : 0;
  const sepActualLen = displayDesc ? sepLen : 0;
  const usedLen = fixedLen + sepActualLen + descLen;
  const spacerLen = Math.max(1, DETAIL_INNER_WIDTH - usedLen);
  const spacer = " ".repeat(spacerLen);

  return (
    <Box flexDirection="row" marginTop={0}>
      {/* Focus bar AFUERA del bg — barrita independiente */}
      <Text color={focusBarColor} bold={focused}>
        {focused ? icons.focusBar : " "}
      </Text>
      <Text> </Text>
      {/* bg highlight empieza acá */}
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
