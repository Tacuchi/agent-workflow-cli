import { TextInput } from "@inkjs/ui";
import { Box, Text } from "ink";
import { useState } from "react";
import { colors, icons } from "../theme.js";

export interface InputPromptProps {
  message: string;
  defaultValue?: string;
  validate?: (value: string) => boolean | string;
  onSubmit: (value: string) => void;
  isActive?: boolean;
}

export function InputPrompt(props: InputPromptProps) {
  const { message, defaultValue, validate, onSubmit, isActive = true } = props;
  const [error, setError] = useState<string | undefined>();

  const handleSubmit = (value: string) => {
    if (validate) {
      const result = validate(value);
      if (result === true) {
        setError(undefined);
        onSubmit(value);
        return;
      }
      setError(typeof result === "string" ? result : "Invalid value");
      return;
    }
    setError(undefined);
    onSubmit(value);
  };

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={colors.accent}>{icons.promptMark} </Text>
        <Text color={colors.text} bold>
          {message}
        </Text>
      </Box>
      <Box marginLeft={2} marginTop={1}>
        <Text color={colors.mute}>{icons.arrow} </Text>
        <TextInput
          isDisabled={!isActive}
          {...(defaultValue !== undefined ? { defaultValue } : {})}
          onSubmit={handleSubmit}
        />
      </Box>
      {error ? (
        <Box marginLeft={2} marginTop={1}>
          <Text color={colors.err}>
            {icons.cross} {error}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
