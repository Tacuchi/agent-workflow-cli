import { Box, Text, useStdout } from "ink";
import { colors, icons } from "../theme.js";

export type MetaTone = "ok" | "warn" | "accent" | "dim" | "err" | "purple" | "info";

export interface MetaChip {
  label: string;
  tone?: MetaTone;
}

export interface StatePill {
  label: string;
  tone?: MetaTone;
}

export interface ListRowProps {
  /** Glyph at left after focus bar; e.g. ▤ (db) for MCP, ◆ (host) for Skills. */
  icon?: string;
  iconActive?: boolean;
  title: string;
  subtitle?: string;
  meta?: MetaChip[];
  state?: StatePill;
  chevron?: boolean;
  active?: boolean;
  /** When true, the row is rendered dimmed (e.g. inline wizard backdrop). */
  dimmed?: boolean;
  /**
   * Ancho disponible del row (en cells). Si se pasa, se usa exactamente.
   * Pasalo desde el parent (que sabe si el detail panel está abierto).
   * Fallback: termCols - 36.
   */
  widthHint?: number;
}

// Padding interno (en cells) que se aplica DENTRO del marker bg, a cada lado
// del contenido. Hace que el bg no se vea pegado a las letras.
const INNER_PAD = 1;

function toneColor(tone?: MetaTone): string {
  switch (tone) {
    case "ok":
      return colors.ok;
    case "warn":
      return colors.warn;
    case "accent":
      return colors.accent;
    case "err":
      return colors.err;
    case "purple":
      return colors.purple;
    case "info":
      return colors.info;
    default:
      return colors.dim;
  }
}

function approxWidth(s: string): number {
  return [...s].length;
}

export function ListRow({
  icon = icons.bullet,
  iconActive = false,
  title,
  subtitle,
  meta = [],
  state,
  chevron = false,
  active = false,
  dimmed = false,
  widthHint,
}: ListRowProps) {
  const { stdout } = useStdout();
  const focused = active && !dimmed;
  const bg = focused ? colors.bgHighlight : undefined;
  const bgProp = bg ? { backgroundColor: bg } : {};

  const focusBarColor = focused ? colors.accent : colors.faint;
  const iconColor = dimmed
    ? colors.faint
    : focused
      ? colors.accent
      : iconActive
        ? colors.accent
        : colors.dim;
  const titleColor = dimmed ? colors.faint : colors.bright;
  const subColor = dimmed ? colors.faint : focused ? colors.accentSoft : colors.dim;
  const metaBaseColor = focused ? colors.accentSoft : undefined;
  const stateColor = dimmed ? colors.faint : focused ? colors.bright : toneColor(state?.tone);
  const chevronColor = dimmed ? colors.faint : focused ? colors.accent : colors.dim;

  // Available: widthHint del parent o fallback (termCols - overhead).
  const fallbackOverhead = 36;
  const available =
    widthHint !== undefined ? widthHint : Math.max(8, (stdout?.columns ?? 100) - fallbackOverhead);

  // RightLen — content alineado a la derecha. Siempre full (no truncar).
  const rightLen =
    meta.reduce((a, m) => a + approxWidth(m.label) + 1, 0) +
    (state ? approxWidth(state.label) + 1 : 0) +
    (chevron ? 2 : 0) +
    INNER_PAD;

  // Pre-truncar subtitle si excede el ancho disponible. Title se preserva.
  // fixedLeft incluye el focus-bar (1) + gap (1) afuera del bg, + INNER_PAD
  // (1) dentro del bg + icon (1) + space (1) + title.
  const FOCUS_OUTER = 2; // bar + gap
  const fixedLeft = FOCUS_OUTER + INNER_PAD + 2 + approxWidth(title);
  const subtitleSpaceBefore = subtitle ? 1 : 0;
  const availableForSubtitle = Math.max(
    0,
    available - fixedLeft - subtitleSpaceBefore - rightLen - 1,
  );
  let displaySubtitle = subtitle ?? "";
  if (subtitle && approxWidth(subtitle) > availableForSubtitle) {
    if (availableForSubtitle <= 1) {
      displaySubtitle = "";
    } else {
      displaySubtitle = `${subtitle.slice(0, availableForSubtitle - 1)}…`;
    }
  }

  // LeftLen recalculado con el subtitle ya truncado.
  // Incluye focus bar (1) + gap (1) afuera del bg + inner_pad + 2 (icon+space)
  // + title + (space + subtitle)? para fines de spacer.
  const leftLen =
    FOCUS_OUTER +
    INNER_PAD +
    2 +
    approxWidth(title) +
    (displaySubtitle ? approxWidth(displaySubtitle) + 1 : 0);
  const spacerLen = Math.max(1, available - leftLen - rightLen);
  const spacer = " ".repeat(spacerLen);
  const innerPad = " ".repeat(INNER_PAD);

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" paddingX={0}>
        {/* Focus bar AFUERA del bg — barrita independiente como indicador */}
        <Text color={focusBarColor} bold={focused}>
          {focused ? icons.focusBar : " "}
        </Text>
        {/* Gap entre la barrita y el bg highlight */}
        <Text> </Text>
        {/* bg highlight empieza acá */}
        <Text {...bgProp}>{innerPad}</Text>
        <Text {...bgProp} color={iconColor} bold={focused}>
          {icon}
        </Text>
        <Text {...bgProp}> </Text>
        <Text {...bgProp} color={titleColor} bold={focused}>
          {title}
        </Text>
        {displaySubtitle ? (
          <>
            <Text {...bgProp}> </Text>
            <Text {...bgProp} color={subColor} bold={focused} wrap="truncate-end">
              {displaySubtitle}
            </Text>
          </>
        ) : null}
        <Text {...bgProp} wrap="truncate-end">
          {spacer}
        </Text>
        {meta.length > 0
          ? meta.map((m, i) => (
              <Box key={`${m.label}-${i}`}>
                <Text {...bgProp} color={metaBaseColor ?? toneColor(m.tone)} bold={focused}>
                  {m.label}
                </Text>
                <Text {...bgProp}> </Text>
              </Box>
            ))
          : null}
        {state ? (
          <Text {...bgProp} color={stateColor} bold={focused || !dimmed}>
            {state.label}
          </Text>
        ) : null}
        {chevron ? (
          <>
            <Text {...bgProp}> </Text>
            <Text {...bgProp} color={chevronColor} bold={focused}>
              {icons.chevron}
            </Text>
          </>
        ) : null}
        <Text {...bgProp}>{innerPad}</Text>
      </Box>
    </Box>
  );
}
