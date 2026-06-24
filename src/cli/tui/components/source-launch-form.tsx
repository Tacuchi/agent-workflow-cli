import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { LaunchDescriptor } from "../../../application/source-launch-scripts-service.js";
import { colors, icons } from "../theme.js";
import { InputPrompt } from "./input-prompt.js";
import { SectionHead } from "./section-head.js";

export interface LaunchFormValue {
  profile: string | null;
  values: Record<string, string>;
}

export interface SourceLaunchFormProps {
  descriptor: LaunchDescriptor;
  isActive?: boolean;
  onSubmit: (value: LaunchFormValue) => void;
  onCancel: () => void;
}

type Step =
  | { kind: "profile" }
  | { kind: "param"; profile: string | null; index: number; values: Record<string, string> };

/** "(sin perfil)" sentinel + the descriptor profiles. */
function profileOptions(desc: LaunchDescriptor): { label: string; value: string | null }[] {
  return [
    { label: "(sin perfil)", value: null },
    ...desc.profiles.map((p) => ({ label: p, value: p })),
  ];
}

/**
 * Form to launch a source: pick a profile (if the descriptor declares any), then
 * enter each parameter (prefilled with its default; secrets are tagged and not
 * prefilled). Sources without profiles/params never reach here — the caller
 * launches them directly.
 */
export function SourceLaunchForm({
  descriptor,
  isActive = true,
  onSubmit,
  onCancel,
}: SourceLaunchFormProps) {
  const options = profileOptions(descriptor);
  const hasProfiles = descriptor.profiles.length > 0;
  const [step, setStep] = useState<Step>(
    hasProfiles ? { kind: "profile" } : { kind: "param", profile: null, index: 0, values: {} },
  );
  const [profileCursor, setProfileCursor] = useState(0);

  // Esc cancels from the profile step (param steps cancel via their own esc below).
  useInput(
    (_input, key) => {
      if (!isActive) return;
      if (step.kind === "profile") {
        if (key.escape) return onCancel();
        if (key.upArrow) return setProfileCursor((c) => Math.max(0, c - 1));
        if (key.downArrow) return setProfileCursor((c) => Math.min(options.length - 1, c + 1));
        if (key.return) {
          const profile = options[profileCursor]?.value ?? null;
          advance(profile, 0, {});
        }
      } else if (key.escape) {
        onCancel();
      }
    },
    { isActive },
  );

  function advance(profile: string | null, index: number, values: Record<string, string>) {
    if (index >= descriptor.params.length) {
      onSubmit({ profile, values });
      return;
    }
    setStep({ kind: "param", profile, index, values });
  }

  if (step.kind === "profile") {
    return (
      <Box flexDirection="column">
        <SectionHead label={`Lanzar ${descriptor.source} · perfil`} marginTop={0} />
        <Box marginLeft={2} marginTop={1} flexDirection="column">
          {options.map((o, i) => (
            <Text key={o.label} color={i === profileCursor ? colors.accent : colors.dim}>
              {i === profileCursor ? icons.arrow : " "} {o.label}
            </Text>
          ))}
        </Box>
        <Box marginTop={1} marginLeft={2}>
          <Text color={colors.faint}>↑↓ perfil · ⏎ continuar · esc cancelar</Text>
        </Box>
      </Box>
    );
  }

  // Param step.
  const param = descriptor.params[step.index];
  if (!param) {
    // No params left (defensive) — submit.
    onSubmit({ profile: step.profile, values: step.values });
    return null;
  }
  const tag = param.secret ? " (secreto — no se guarda)" : "";
  return (
    <Box flexDirection="column">
      <SectionHead
        label={`Lanzar ${descriptor.source}${step.profile ? ` · ${step.profile}` : ""}`}
        marginTop={0}
      />
      <Box marginLeft={2} marginTop={1} flexDirection="column">
        <Text color={colors.faint}>
          parámetro {step.index + 1}/{descriptor.params.length}
        </Text>
        <InputPrompt
          key={param.name}
          message={`${param.name}${tag}`}
          {...(param.secret ? {} : { defaultValue: param.default })}
          isActive={isActive}
          onSubmit={(value) => {
            const next = { ...step.values, [param.name]: value };
            advance(step.profile, step.index + 1, next);
          }}
        />
        <Box marginTop={1}>
          <Text color={colors.faint}>⏎ siguiente · esc cancelar</Text>
        </Box>
      </Box>
    </Box>
  );
}
