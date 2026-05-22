import { Box, Text } from "ink";
import { colors, icons } from "../theme.js";

export interface HeaderProps {
  version: string;
  cwd?: string;
  homeDir?: string;
}

/**
 * Header — minimal chrome superior.
 *
 * Izquierda: diamante + name + version. Derecha: path corto.
 * Sin "live indicator" — ruido innecesario.
 */
export function Header({ version, cwd, homeDir }: HeaderProps) {
  const path = cwd ? prettyPath(cwd, homeDir) : undefined;
  return (
    <Box justifyContent="space-between" marginBottom={1}>
      <Box>
        <Text color={colors.accent}>{icons.brand}</Text>
        <Text> </Text>
        <Text color={colors.fgBright} bold>
          agent-workflow
        </Text>
        <Text color={colors.fgFaint}> v{version}</Text>
      </Box>
      {path ? <Text color={colors.fgMoreSubtle}>{path}</Text> : null}
    </Box>
  );
}

export function prettyPath(cwd: string, homeDir?: string): string {
  if (homeDir && cwd.startsWith(homeDir)) {
    const rest = cwd.slice(homeDir.length);
    return `~${rest}`;
  }
  return cwd;
}
