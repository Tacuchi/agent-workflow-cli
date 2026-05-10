import { Box, Text } from "ink";
import { colors } from "../theme.js";

export type ConfirmTone = "warning" | "danger" | "info";

const TONE_TO_BORDER: Record<ConfirmTone, string> = {
  warning: colors.warning,
  danger: colors.error,
  info: colors.info,
};

const TONE_TO_ICON: Record<ConfirmTone, string> = {
  warning: "⚠",
  danger: "⚠",
  info: "ⓘ",
};

export interface ConfirmModalProps {
  tone: ConfirmTone;
  title: string;
  body: string | string[];
  confirmKey: string;
  cancelKey: string;
  confirmLabel: string;
  cancelLabel: string;
}

export function ConfirmModal({
  tone,
  title,
  body,
  confirmKey,
  cancelKey,
  confirmLabel,
  cancelLabel,
}: ConfirmModalProps) {
  const lines = Array.isArray(body) ? body : [body];
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={TONE_TO_BORDER[tone]}
      paddingX={2}
      paddingY={1}
    >
      <Box>
        <Text color={TONE_TO_BORDER[tone]} bold>
          {TONE_TO_ICON[tone]} {title}
        </Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {lines.map((line) => (
          <Text key={line} color={colors.fg}>
            {line}
          </Text>
        ))}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Box>
          <Text color={TONE_TO_BORDER[tone]} bold>
            {confirmKey}
          </Text>
          <Text color={colors.fgMoreSubtle}> </Text>
          <Text color={colors.fg}>{confirmLabel}</Text>
        </Box>
        <Box>
          <Text color={colors.fgSubtle} bold>
            {cancelKey}
          </Text>
          <Text color={colors.fgMoreSubtle}> </Text>
          <Text color={colors.fgSubtle}>{cancelLabel}</Text>
        </Box>
      </Box>
    </Box>
  );
}
