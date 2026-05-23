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
}

export function PhaseCard({ phase }: PhaseCardProps) {
  const visibleCmds = phase.commands.slice(0, 3);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={colors.border}
      paddingX={1}
      flexGrow={1}
      marginRight={1}
    >
      <Box flexDirection="row">
        <Text color={colors.accent} bold>
          {phase.n}.
        </Text>
        <Text color={colors.fgBright} bold>
          {" "}
          {phase.title}
        </Text>
      </Box>
      <Text color={colors.fgSubtle} wrap="wrap">
        {phase.desc}
      </Text>
      {visibleCmds.length > 0 ? (
        <Box flexDirection="column">
          {visibleCmds.map((c) => (
            <Text key={c} color={colors.fg}>
              · {c}
            </Text>
          ))}
        </Box>
      ) : null}
      {phase.slash && phase.slash !== "—" ? (
        <Box>
          <Text color={colors.fgSubtle}>{icons.chevron} </Text>
          <Text color={colors.accent}>{phase.slash}</Text>
        </Box>
      ) : null}
      {phase.hook && phase.hook !== "—" ? (
        <Box>
          <Text color={colors.fgSubtle}>{icons.hook} </Text>
          <Text color={colors.success}>{phase.hook}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
