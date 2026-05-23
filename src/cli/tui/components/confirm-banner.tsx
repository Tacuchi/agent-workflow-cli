import { Box, Text } from "ink";
import { colors, icons } from "../theme.js";

export interface ConfirmBannerProps {
  title: string;
  body: string;
  confirmKey?: string;
  confirmLabel?: string;
  cancelKeys?: string;
  cancelLabel?: string;
}

const DEFAULT_CONFIRM_KEY = "y";
const DEFAULT_CONFIRM_LABEL = "confirm";
const DEFAULT_CANCEL_KEYS = "n / esc";
const DEFAULT_CANCEL_LABEL = "cancel";

export function ConfirmBanner({
  title,
  body,
  confirmKey = DEFAULT_CONFIRM_KEY,
  confirmLabel = DEFAULT_CONFIRM_LABEL,
  cancelKeys = DEFAULT_CANCEL_KEYS,
  cancelLabel = DEFAULT_CANCEL_LABEL,
}: ConfirmBannerProps) {
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
            {confirmKey}
          </Text>
          <Text color={colors.dim}> · {confirmLabel} </Text>
          <Text color={colors.dim}>{cancelKeys}</Text>
          <Text color={colors.dim}> · {cancelLabel}</Text>
        </Box>
      </Box>
    </Box>
  );
}
