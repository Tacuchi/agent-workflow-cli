import { Box, Text } from "ink";
import { colors, icons } from "../theme.js";

export interface PaletteCommand {
  id: string;
  label: string;
  category: string;
  hint?: string;
}

export interface CommandPaletteProps {
  filter: string;
  commands: PaletteCommand[];
  cursor: number;
  groups?: Array<{ category: string; commands: PaletteCommand[] }>;
}

const PLACEHOLDER = "type to filter…";

export function CommandPalette({ filter, commands, cursor }: CommandPaletteProps) {
  const groups: Array<{ category: string; rows: PaletteCommand[] }> = [];
  for (const c of commands) {
    const last = groups[groups.length - 1];
    if (last && last.category === c.category) {
      last.rows.push(c);
    } else {
      groups.push({ category: c.category, rows: [c] });
    }
  }

  let runningIdx = 0;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={colors.accent}
      paddingX={2}
      paddingY={1}
    >
      {/* Search input */}
      <Box flexDirection="row" marginBottom={1}>
        <Text color={colors.mute}>search </Text>
        <Text color={colors.accent} bold>
          ›{" "}
        </Text>
        {filter ? (
          <Text color={colors.bright}>{filter}</Text>
        ) : (
          <Text color={colors.faint}>{PLACEHOLDER}</Text>
        )}
        <Text color={colors.accent}>{icons.caret}</Text>
        <Box flexGrow={1} />
        <Text color={colors.mute}>
          {commands.length} match{commands.length === 1 ? "" : "es"}
        </Text>
      </Box>
      <Box marginBottom={1}>
        <Text color={colors.borderFaint}>{"─".repeat(70)}</Text>
      </Box>

      {/* Empty state */}
      {commands.length === 0 ? (
        <Text color={colors.dim}>No matches for "{filter || "…"}".</Text>
      ) : null}

      {/* Grouped command list */}
      {groups.map((g) => (
        <Box key={g.category} flexDirection="column" marginBottom={1}>
          <Text color={colors.mute}>{g.category.toUpperCase()}</Text>
          {g.rows.map((c) => {
            const idx = runningIdx++;
            const active = idx === cursor;
            return (
              <Box key={c.id} flexDirection="row">
                <Box width={2}>
                  <Text color={active ? colors.accent : colors.faint}>
                    {active ? icons.focusBar : " "}
                  </Text>
                </Box>
                <Box flexGrow={1}>
                  <Text color={active ? colors.accent : colors.bright} bold={active}>
                    {c.label}
                  </Text>
                </Box>
                {c.hint ? (
                  <Box marginLeft={1}>
                    <Text color={colors.dim}>{c.hint}</Text>
                  </Box>
                ) : null}
              </Box>
            );
          })}
        </Box>
      ))}

      {/* Footer hint */}
      <Box marginTop={0}>
        <Text color={colors.faint}>↑↓ navigate · ⏎ run · esc close</Text>
      </Box>
    </Box>
  );
}
