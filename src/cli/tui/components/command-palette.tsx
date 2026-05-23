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
  /** Optional pre-grouped sections. If provided, overrides flat list. */
  groups?: Array<{ category: string; commands: PaletteCommand[] }>;
}

export function CommandPalette({ filter, commands, cursor }: CommandPaletteProps) {
  // Group by category to render section headers.
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
      <Box>
        <Text color={colors.accent} bold>
          {icons.search}{" "}
        </Text>
        <Text color={colors.fgBright}>{filter}</Text>
        <Text color={colors.accent}>{icons.promptMark}</Text>
      </Box>
      <Box
        borderStyle="single"
        borderColor={colors.borderFaint}
        borderTop={false}
        borderLeft={false}
        borderRight={false}
        marginBottom={1}
      />

      {/* Empty state */}
      {commands.length === 0 ? (
        <Text color={colors.fgSubtle}>Sin coincidencias para “{filter || "…"}”.</Text>
      ) : null}

      {/* Grouped command list */}
      {groups.map((g) => (
        <Box key={g.category} flexDirection="column" marginBottom={1}>
          <Text color={colors.fgMoreSubtle}>{g.category.toUpperCase()}</Text>
          {g.rows.map((c) => {
            const idx = runningIdx++;
            const active = idx === cursor;
            return (
              <Box key={c.id} flexDirection="row">
                <Box width={2}>
                  <Text color={active ? colors.accent : "transparent"} bold>
                    {active ? icons.play : " "}
                  </Text>
                </Box>
                <Box flexGrow={1}>
                  <Text color={active ? colors.accent : colors.fgBright} bold={active}>
                    {c.label}
                  </Text>
                </Box>
                {c.hint ? (
                  <Box marginLeft={1}>
                    <Text color={colors.fgSubtle}>{c.hint}</Text>
                  </Box>
                ) : null}
              </Box>
            );
          })}
        </Box>
      ))}

      {/* Footer hint */}
      <Box marginTop={0}>
        <Text color={colors.fgSubtle}>↑↓ navegar · ⏎ ejecutar · Esc cerrar</Text>
      </Box>
    </Box>
  );
}
