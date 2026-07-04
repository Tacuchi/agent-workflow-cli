import { Box, Text } from "ink";
import { colors, icons } from "../theme.js";

export interface ConfirmBannerProps {
  title: string;
  body: string;
}

export function ConfirmBanner({ title, body }: ConfirmBannerProps) {
  return (
    <Box flexDirection="row">
      <Text color={colors.err}>{icons.focusBar}</Text>
      <Box flexDirection="column" paddingLeft={1} flexGrow={1}>
        <Text color={colors.err} bold>
          {title}
        </Text>
        <Text color={colors.text}>{body}</Text>
        <Box marginTop={1} flexDirection="row">
          <Text color={colors.err} bold>
            y
          </Text>
          <Text color={colors.dim}> · confirm </Text>
          <Text color={colors.dim}>n / esc</Text>
          <Text color={colors.dim}> · cancel</Text>
        </Box>
      </Box>
    </Box>
  );
}
