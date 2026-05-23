import { Box, Text } from "ink";
import { colors } from "../theme.js";

export interface QuickAction {
  key: string;
  label: string;
}

export interface QuickActionsProps {
  actions: QuickAction[];
}

export function QuickActions({ actions }: QuickActionsProps) {
  if (!actions.length) return null;
  return (
    <Box flexDirection="column">
      <Text color={colors.borderFaint}>{"─".repeat(60)}</Text>
      <Box marginTop={0}>
        {actions.map((action, idx) => (
          <Box key={`${action.key}-${action.label}`}>
            {idx > 0 ? <Text color={colors.faint}> · </Text> : null}
            <Text color={colors.accent} bold>
              {action.key}
            </Text>
            <Text> </Text>
            <Text color={colors.text}>{action.label}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
