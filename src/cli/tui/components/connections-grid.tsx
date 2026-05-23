import { Box, Text } from "ink";
import type { SelfMcpConnectionView } from "../../../application/self/mcp-config.js";
import { colors, icons } from "../theme.js";

const STATUS_ICON: Record<"si" | "no" | "drift", string> = {
  si: icons.check,
  no: "–",
  drift: "!",
};

const STATUS_COLOR: Record<"si" | "no" | "drift", string> = {
  si: colors.success,
  no: colors.fgMoreSubtle,
  drift: colors.warning,
};

export interface ConnectionsGridProps {
  connections: SelfMcpConnectionView[];
  cursor: number;
  isActive: boolean;
}

export function ConnectionsGrid({ connections, cursor, isActive }: ConnectionsGridProps) {
  if (connections.length === 0) {
    return (
      <Box>
        <Text color={colors.fgMoreSubtle} italic>
          (no registered connections — press{" "}
          <Text color={colors.accent} bold>
            n
          </Text>{" "}
          to create one)
        </Text>
      </Box>
    );
  }

  const widths = computeColumnWidths(connections);
  return (
    <Box flexDirection="column">
      {/* header */}
      <Box>
        <Text color={colors.fgMoreSubtle}> </Text>
        <ColumnHeader text="name" width={widths.name} />
        <Spacer />
        <ColumnHeader text="DSN var" width={widths.dsn} />
        <Spacer />
        <ColumnHeader text="Claude" width={widths.claude} />
        <Spacer />
        <ColumnHeader text="Codex" width={widths.codex} />
        <Spacer />
        <ColumnHeader text="Warp" width={widths.warp} />
      </Box>
      {/* rule */}
      <Box>
        <Text color={colors.fgMoreSubtle}> </Text>
        <Text color={colors.fgMoreSubtle}>
          {"─".repeat(widths.name + widths.dsn + widths.claude + widths.codex + widths.warp + 8)}
        </Text>
      </Box>
      {/* rows */}
      {connections.map((c, i) => {
        const focused = isActive && i === cursor;
        const labelColor = focused ? colors.fg : colors.fgSubtle;
        return (
          <Box key={c.nombre}>
            <Text color={focused ? colors.primary : colors.fgMoreSubtle} bold={focused}>
              {focused ? icons.focusBullet : " "}
            </Text>
            <Text color={labelColor} {...(focused ? { bold: true } : {})}>
              {pad(c.nombre, widths.name)}
            </Text>
            <Spacer />
            <Text color={colors.fgSubtle}>{pad(c.dsn_var, widths.dsn)}</Text>
            <Spacer />
            <StatusCell status={c.instalado.claude_code} width={widths.claude} />
            <Spacer />
            <StatusCell status={c.instalado.codex} width={widths.codex} />
            <Spacer />
            <StatusCell status={c.instalado.warp} width={widths.warp} />
          </Box>
        );
      })}
    </Box>
  );
}

function ColumnHeader({ text, width }: { text: string; width: number }) {
  return (
    <Text color={colors.fgMoreSubtle} bold>
      {pad(text, width)}
    </Text>
  );
}

function StatusCell({
  status,
  width,
}: {
  status: "si" | "no" | "drift";
  width: number;
}) {
  const icon = STATUS_ICON[status];
  const color = STATUS_COLOR[status];
  const padded = centerPad(icon, width);
  return (
    <Text color={color} bold={status === "si"}>
      {padded}
    </Text>
  );
}

function Spacer() {
  return <Text>{"  "}</Text>;
}

function pad(text: string, width: number): string {
  if (text.length >= width) return text;
  return text + " ".repeat(width - text.length);
}

function centerPad(text: string, width: number): string {
  if (text.length >= width) return text;
  const total = width - text.length;
  const left = Math.floor(total / 2);
  const right = total - left;
  return " ".repeat(left) + text + " ".repeat(right);
}

function computeColumnWidths(connections: SelfMcpConnectionView[]): {
  name: number;
  dsn: number;
  claude: number;
  codex: number;
  warp: number;
} {
  const name = Math.max("name".length, ...connections.map((c) => c.nombre.length));
  const dsn = Math.max("DSN var".length, ...connections.map((c) => c.dsn_var.length));
  return { name, dsn, claude: "Claude".length, codex: "Codex".length, warp: "Warp".length };
}
