import { Box, Text } from "ink";
import { colors } from "../theme.js";
import { Pill, type PillTone } from "./pill.js";

export interface PageHeadProps {
  /** Título principal */
  title: string;
  /** Pill opcional al lado del título (counter, status) */
  count?: { label: string; tone?: PillTone };
}

/**
 * PageHead minimal — solo título bold + count opcional al lado.
 *
 * Antes incluía eyebrow + lede; los quitamos porque eran ruido en cada tab.
 * Si un tab quiere prosa adicional, la inline donde aporte.
 */
export function PageHead({ title, count }: PageHeadProps) {
  return (
    <Box marginBottom={1}>
      <Text color={colors.fgBright} bold>
        {title}
      </Text>
      {count ? (
        <Box marginLeft={1}>
          <Pill tone={count.tone ?? "muted"} preserveCase>
            {count.label}
          </Pill>
        </Box>
      ) : null}
    </Box>
  );
}
