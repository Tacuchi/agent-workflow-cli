import { Box, Text } from "ink";
import { colors } from "../theme.js";

export interface FamilyCardData {
  id: string;
  title: string;
  items: string[];
}

export interface FamilyCardProps {
  family: FamilyCardData;
}

export function FamilyCard({ family }: FamilyCardProps) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={colors.border}
      paddingX={1}
      flexGrow={1}
      marginRight={1}
    >
      <Box>
        <Text color={colors.fgBright} bold>
          {family.title}
        </Text>
        <Text color={colors.accent}> {family.items.length}</Text>
      </Box>
      <Box flexDirection="column">
        {family.items.map((cmd) => (
          <Text key={cmd} color={colors.fg}>
            · {cmd}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
