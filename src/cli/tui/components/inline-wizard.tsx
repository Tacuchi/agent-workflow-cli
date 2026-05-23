import { Box, Text } from "ink";
import { colors, icons } from "../theme.js";

export interface InlineWizardField {
  label: string;
  value: string;
  /** When true, the field shows a blinking caret at the end (visual only — Ink doesn't animate). */
  active?: boolean;
}

export interface InlineWizardProps {
  step: number;
  totalSteps: number;
  stepLabel: string;
  fields: InlineWizardField[];
  /** Live preview block (e.g. JSON). Multi-line string with \n separators. */
  preview?: string;
  /** Override default footer. */
  footer?: string;
  width?: number;
}

const DEFAULT_FOOTER = "⏎ register · tab back to step 1 · esc cancel";

export function InlineWizard({
  step,
  totalSteps,
  stepLabel,
  fields,
  preview,
  footer = DEFAULT_FOOTER,
  width = 56,
}: InlineWizardProps) {
  return (
    <Box flexDirection="row" marginTop={1}>
      <Box>
        <Text color={colors.accent}>{icons.focusBar}</Text>
      </Box>
      <Box flexDirection="column" paddingLeft={1} flexGrow={1}>
        <Box>
          <Text color={colors.accent}>
            Step {step} of {totalSteps} ·{" "}
          </Text>
          <Text color={colors.accent} bold>
            {stepLabel.toUpperCase()}
          </Text>
        </Box>

        {fields.map((f) => (
          <WizardFieldRow key={f.label} field={f} width={width} />
        ))}

        {preview ? <PreviewBlock content={preview} /> : null}

        <Box marginTop={1}>
          <Text color={colors.dim}>{footer}</Text>
        </Box>
      </Box>
    </Box>
  );
}

function WizardFieldRow({
  field,
  width,
}: {
  field: InlineWizardField;
  width: number;
}) {
  const labelText = `${field.label}: `;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={colors.mute}>{field.label.toUpperCase()}</Text>
      <Box>
        <Text color={colors.dim}>{"┌"}</Text>
        <Text color={colors.dim}>{"─".repeat(Math.max(0, width - 4))}</Text>
        <Text color={colors.dim}>{"┐"}</Text>
      </Box>
      <Box>
        <Text color={colors.dim}>{"│ "}</Text>
        <Text color={colors.bright}>{field.value}</Text>
        {field.active ? <Text color={colors.accent}>{icons.caret}</Text> : null}
        <Box flexGrow={1} />
        <Text color={colors.dim}>{" │"}</Text>
      </Box>
      <Box>
        <Text color={colors.dim}>{"└"}</Text>
        <Text color={colors.dim}>{"─".repeat(Math.max(0, width - 4))}</Text>
        <Text color={colors.dim}>{"┘"}</Text>
      </Box>
      <Text color={colors.faint}>{labelText}</Text>
    </Box>
  );
}

function PreviewBlock({ content }: { content: string }) {
  const lines = content.split("\n");
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={colors.mute}>PREVIEW · profile.json</Text>
      {lines.map((line, idx) => (
        <Text key={`prev-${idx}-${line.slice(0, 8)}`} color={colors.dim}>
          {line}
        </Text>
      ))}
    </Box>
  );
}
