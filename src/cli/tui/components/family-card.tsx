import { Box, Text, useStdout } from "ink";
import { colors, icons } from "../theme.js";

export interface FamilyCardData {
  id: string;
  title: string;
  items: string[];
}

export interface FamilyCardProps {
  family: FamilyCardData;
  expanded?: boolean;
  active?: boolean;
  /** Ancho fijado por el parent (columna derecha del workflow tab). */
  widthHint?: number;
}

const COLLAPSED_GLYPH = "▶";
const EXPANDED_GLYPH = "▼";
const INNER_PAD = 1;

export function FamilyCard({
  family,
  expanded = false,
  active = false,
  widthHint,
}: FamilyCardProps) {
  const { stdout } = useStdout();
  const bg = active ? colors.bgHighlight : undefined;
  const bgProp = bg ? { backgroundColor: bg } : {};
  const innerPad = " ".repeat(INNER_PAD);

  // Layout: bar + gap + pad + expand_glyph + space + title + space + count + pad.
  // Bar va AFUERA del bg.
  const FOCUS_OUTER = 2;
  const titleLen = [...family.title].length;
  const countStr = String(family.items.length);
  const countLen = countStr.length;
  const used =
    FOCUS_OUTER + INNER_PAD * 2 + 1 + 1 + titleLen + 1 + countLen;

  const termCols = stdout?.columns ?? 100;
  // Overhead aproximado: ScreenFrame (6) + Sidebar (24) + Main paddingX (2) +
  // right column paddingLeft (1) = 33. Restamos solo 33 (en vez de 35) para
  // que el spacer sea generoso; truncate-end recorta si pasa el borde real.
  const fallbackColWidth = Math.max(20, Math.floor((termCols - 33) / 2));
  const colWidth = widthHint ?? fallbackColWidth;
  const spacerLen = Math.max(1, colWidth - used);
  const spacer = " ".repeat(spacerLen);

  const expandGlyph = expanded ? EXPANDED_GLYPH : COLLAPSED_GLYPH;

  // Una sola Text con bg uniforme (incluso el focus bar tiene bg) — evita
  // los problemas de mixing bg/no-bg Texts en una row que provocan blank lines
  // entre rows.
  const headerRow = (
    <Text wrap="truncate-end">
      <Text {...bgProp} color={active ? colors.accent : colors.faint}>
        {active ? icons.focusBar : " "}
      </Text>
      <Text {...bgProp}>
        {innerPad}
        <Text color={colors.accent} bold>
          {expandGlyph}
        </Text>{" "}
        <Text color={colors.bright} bold>
          {family.title}
        </Text>{" "}
        <Text color={colors.accent}>{countStr}</Text>
        {spacer}
        {innerPad}
      </Text>
    </Text>
  );

  if (expanded) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        {headerRow}
        <Box marginLeft={5} flexDirection="column">
          {family.items.map((cmd) => (
            <Text key={cmd} color={colors.dim}>
              · {cmd}
            </Text>
          ))}
        </Box>
      </Box>
    );
  }
  return headerRow;
}
