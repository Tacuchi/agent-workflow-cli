import { Box, Text } from "ink";
import { colors, icons } from "../theme.js";

export interface PhaseCardData {
  id: string;
  n: number;
  title: string;
  desc: string;
  commands: string[];
  slash?: string;
  hook?: string;
}

export interface PhaseCardProps {
  phase: PhaseCardData;
  active?: boolean;
}

const CIRCLED = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩"];
function circled(n: number): string {
  return CIRCLED[n - 1] ?? String(n);
}

export function PhaseCard({ phase, active = false }: PhaseCardProps) {
  const cmds = phase.commands.slice(0, 3);
  const cmdsText = cmds.join(" · ") + (phase.commands.length > 3 ? " …" : "");

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={active ? colors.accent : colors.faint}>{active ? icons.focusBar : " "}</Text>
        <Text> </Text>
        <Text color={active ? colors.accent : colors.mute} bold={active}>
          {circled(phase.n)}
        </Text>
        <Text> </Text>
        <Text color={colors.bright} bold>
          {phase.title}
        </Text>
        {active ? (
          <>
            <Text> </Text>
            <Text color={colors.accent}>●</Text>
            <Text> </Text>
            <Text color={colors.accent} bold>
              ACTIVE
            </Text>
          </>
        ) : null}
      </Box>
      <Box marginLeft={3}>
        <Text color={colors.dim} wrap="wrap">
          {phase.desc}
        </Text>
      </Box>
      {cmds.length > 0 ? (
        <Box marginLeft={3}>
          <Text color={colors.dim}>{cmdsText}</Text>
        </Box>
      ) : null}
      {/* Slash + hook en MISMA línea (como image #30 referencia). Usamos
          outer Text con wrap="truncate-end" + nested Text para colores: si la
          columna es narrow, trunca con `…` en vez de wrapear mid-string. */}
      {(phase.slash && phase.slash !== "—") || (phase.hook && phase.hook !== "—") ? (
        <Box marginLeft={3}>
          <Text wrap="truncate-end">
            {phase.slash && phase.slash !== "—" ? (
              <Text color={colors.accent}>{phase.slash}</Text>
            ) : null}
            {phase.slash &&
            phase.slash !== "—" &&
            phase.hook &&
            phase.hook !== "—" ? (
              <Text color={colors.dim}> · </Text>
            ) : null}
            {phase.hook && phase.hook !== "—" ? (
              <Text color={colors.ok}>↪ {phase.hook}</Text>
            ) : null}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
