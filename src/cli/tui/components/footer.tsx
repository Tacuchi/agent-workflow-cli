import { Box, Text } from "ink";

export function Footer({ hint }: { hint: string }) {
  return (
    <Box marginTop={1}>
      <Text color="gray">{hint}</Text>
    </Box>
  );
}
