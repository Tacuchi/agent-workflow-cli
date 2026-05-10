import { Box, Text } from "ink";

export function Header({ version, subtitle }: { version: string; subtitle?: string }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color="cyan" bold>
          agent-workflow
        </Text>
        <Text color="gray"> v{version}</Text>
      </Box>
      {subtitle ? <Text color="gray">{subtitle}</Text> : null}
    </Box>
  );
}
