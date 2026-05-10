import { TextInput } from "@inkjs/ui";
import { Box, Text } from "ink";
import { useState } from "react";

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
      setError(typeof result === "string" ? result : "Valor inválido");
      return;
    }
    setError(undefined);
    onSubmit(value);
  };

  return (
    <Box flexDirection="column">
      <Text>
        <Text color="cyan">? </Text>
        {message}
      </Text>
      <Box marginLeft={2}>
        <TextInput
          isDisabled={!isActive}
          {...(defaultValue !== undefined ? { defaultValue } : {})}
          onSubmit={handleSubmit}
        />
      </Box>
      {error ? (
        <Box marginLeft={2}>
          <Text color="red">{error}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
