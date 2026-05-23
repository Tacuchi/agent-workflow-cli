import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { colors } from "../theme.js";
import { Pill, type PillTone } from "./pill.js";

export interface PageHeadProps {
  /** Título principal */
  title: string;
  /** Pill opcional al lado del título (counter, status, mode) */
  count?: { label: string; tone?: PillTone };
  /** Subtítulo descriptivo inline · color fgSubtle. Mismo concepto del TabPage del prototipo. */
  desc?: string;
  /** Acción opcional alineada a la derecha (típicamente un botón primario en accent bold). */
  action?: ReactNode;
}

/**
 * PageHead — header unificado de cada tab.
 *
 * Layout:
 *   `<title bold> [count pill] <desc dim>           <action>`
 *
 * Match con `TabPage` del handoff (variant-palette.jsx ~líneas 286-314): título +
 * count + desc en una línea con la acción primaria pegada a la derecha. Mantiene
 * proporciones del prototipo respetando límites de Ink (flex, sin gap CSS).
 */
export function PageHead({ title, count, desc, action }: PageHeadProps) {
  return (
    <Box marginBottom={1} flexDirection="row">
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
      {desc ? (
        <Box marginLeft={1} flexGrow={1}>
          <Text color={colors.fgSubtle}>{desc}</Text>
        </Box>
      ) : (
        <Box flexGrow={1} />
      )}
      {action ? <Box>{action}</Box> : null}
    </Box>
  );
}
