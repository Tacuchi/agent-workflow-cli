import { Box, Text } from "ink";
import {
  type SelfMcpConnectionView,
  formatConnectionsTable,
} from "../../../application/self/mcp-config.js";
import { colors } from "../theme.js";

export function ConnectionsTable({ connections }: { connections: SelfMcpConnectionView[] }) {
  if (connections.length === 0) {
    return (
      <Box>
        <Text color={colors.fgMoreSubtle} italic>
          (no registered connections)
        </Text>
      </Box>
    );
  }
  return <Text color={colors.fgSubtle}>{formatConnectionsTable(connections)}</Text>;
}
