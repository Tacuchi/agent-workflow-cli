import { Box, Text, useInput } from "ink";
import type {
  SelfMcpConfigData,
  SelfMcpConnectionView,
} from "../../../application/self/mcp-config.js";
import type { CommandResult } from "../../../domain/types.js";
import { ConnectionsTable } from "../components/connections-table.js";
import { Header } from "../components/header.js";
import { KeymapBar } from "../components/keymap-bar.js";
import { ScreenFrame } from "../components/screen-frame.js";
import { colors, icons } from "../theme.js";

export interface McpDoneScreenProps {
  version: string;
  result: CommandResult<SelfMcpConfigData>;
  onContinue: () => void;
  onExit: () => void;
}

export function McpDoneScreen({ version, result, onContinue, onExit }: McpDoneScreenProps) {
  useInput((input, key) => {
    if (key.return || input === "m" || input === "M") onContinue();
    if (input === "q" || input === "Q" || key.escape) onExit();
  });

  const data = result.data;
  const summary = data?.summary ?? (result.ok ? "Acción completada." : "Acción cancelada o falló.");
  const connections: SelfMcpConnectionView[] = data?.connections ?? [];
  const isCancel = data?.action === "cancel";

  return (
    <ScreenFrame>
      <Header version={version} subtitle="Resultado MCP" />
      <Box marginBottom={1}>
        <Text color={result.ok ? colors.success : colors.error} bold>
          {result.ok ? `${icons.check} ` : `${icons.cross} `}
        </Text>
        <Text color={colors.fg}>{summary}</Text>
      </Box>
      {!isCancel && connections.length > 0 ? (
        <Box flexDirection="column" marginBottom={1}>
          <ConnectionsTable connections={connections} />
        </Box>
      ) : null}
      <KeymapBar
        entries={[
          { key: "⏎", action: "volver al menú" },
          { key: "q", action: "salir" },
        ]}
      />
    </ScreenFrame>
  );
}
