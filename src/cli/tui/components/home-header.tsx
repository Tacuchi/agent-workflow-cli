import { Box, Text } from "ink";
import { colors, icons } from "../theme.js";
import type { WorkspaceContext } from "./tabs-config.js";

export interface HomeHeaderProps {
  brand: string;
  version: string;
  handle?: string;
  workspaceContext: WorkspaceContext;
}

const DEFAULT_HANDLE = "@tacuchi";
const DOT = "·";

export function HomeHeader({
  brand,
  version,
  handle = DEFAULT_HANDLE,
  workspaceContext,
}: HomeHeaderProps) {
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        <Text color={colors.accent} bold>
          {icons.brand}
        </Text>
        <Text color={colors.bright} bold>
          {" "}
          {brand}
        </Text>
        <Text color={colors.faint}>
          {"  "}v{version} {DOT} {handle}
        </Text>
      </Text>
      <Text wrap="truncate-end">
        <Text color={colors.text}>{workspaceContext.modeLabel}</Text>
        <Text color={colors.faint}>
          {"  "}
          {DOT}
          {"  "}
        </Text>
        <Text color={colors.dim}>{workspaceContext.branchLabel}</Text>
        <Text color={colors.faint}>
          {"  "}
          {DOT}
          {"  "}
        </Text>
        <Text color={colors.dim}>{workspaceContext.sessionsLabel}</Text>
      </Text>
    </Box>
  );
}
