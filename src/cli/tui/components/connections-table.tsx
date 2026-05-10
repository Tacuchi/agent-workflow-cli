import { Box, Text } from "ink";
import {
  type SelfMcpConnectionView,
  formatConnectionsTable,
} from "../../../application/self/mcp-config.js";

export function ConnectionsTable({ connections }: { connections: SelfMcpConnectionView[] }) {
  if (connections.length === 0) {
    return (
      <Box>
        <Text color="gray" italic>
          (sin conexiones registradas)
        </Text>
      </Box>
    );
  }
  return <Text>{formatConnectionsTable(connections)}</Text>;
}
