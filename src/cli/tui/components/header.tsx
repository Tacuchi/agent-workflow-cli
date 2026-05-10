import { Box, Text } from "ink";
import { colors, icons } from "../theme.js";

export interface HeaderProps {
  version: string;
  subtitle?: string;
}

export function Header({ version, subtitle }: HeaderProps) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={colors.primary} bold>
          {icons.brand} agent-workflow
        </Text>
        <Text color={colors.fgMoreSubtle}> · </Text>
        <Text color={colors.fgSubtle}>v{version}</Text>
        {subtitle ? (
          <>
            <Text color={colors.fgMoreSubtle}> · </Text>
            <Text color={colors.accent}>{subtitle}</Text>
          </>
        ) : null}
      </Box>
    </Box>
  );
}
