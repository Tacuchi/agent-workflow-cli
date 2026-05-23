import { Box, Text } from "ink";
import { colors, icons } from "../theme.js";
import type { MetaTone, StatePill } from "./list-row.js";

export interface ActionModalAction {
  id: string;
  icon?: string;
  label: string;
  desc?: string;
  danger?: boolean;
  steps?: string[];
  hint?: { tone?: MetaTone; icon?: string; text: string };
}

export interface ActionModalBusy {
  /** id of the action currently running */
  actionId: string;
  /** index of the running step (0-based). Steps before this are done. */
  stepIdx: number;
}

export interface ActionModalProps {
  glyph?: string;
  title: string;
  subtitle?: string;
  state?: StatePill;
  actions: ActionModalAction[];
  cursor: number;
  busy?: ActionModalBusy;
  /** Texto de contexto pegado a la derecha del footer (e.g. nombre conn, bundle version). */
  footerRight?: string;
}

function toneColor(tone?: MetaTone): string {
  switch (tone) {
    case "ok":
      return colors.success;
    case "warn":
      return colors.warning;
    case "accent":
      return colors.accent;
    case "err":
      return colors.error;
    default:
      return colors.fgSubtle;
  }
}

function StepChip({
  label,
  state,
}: {
  label: string;
  state: "pending" | "running" | "done";
}) {
  const color =
    state === "done" ? colors.success : state === "running" ? colors.accent : colors.fgSubtle;
  const glyph = state === "done" ? icons.check : state === "running" ? icons.spinner : "·";
  return (
    <Box marginRight={1}>
      <Text color={color}>
        [{glyph} {label}]
      </Text>
    </Box>
  );
}

export function ActionModal({
  glyph,
  title,
  subtitle,
  state,
  actions,
  cursor,
  busy,
  footerRight,
}: ActionModalProps) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={colors.accent}
      paddingX={2}
      paddingY={1}
    >
      {/* Header */}
      <Box flexDirection="row">
        {glyph ? (
          <Box marginRight={1}>
            <Text color={colors.accent} bold>
              {glyph}
            </Text>
          </Box>
        ) : null}
        <Box flexDirection="column" flexGrow={1}>
          <Text color={colors.fgBright} bold>
            {title}
          </Text>
          {subtitle ? <Text color={colors.fgSubtle}>{subtitle}</Text> : null}
        </Box>
        {state ? (
          <Text color={toneColor(state.tone)} bold>
            {state.label}
          </Text>
        ) : null}
      </Box>

      <Box
        borderStyle="single"
        borderColor={colors.borderFaint}
        borderTop={false}
        borderLeft={false}
        borderRight={false}
        marginY={0}
      />

      {/* Actions */}
      <Box flexDirection="column" marginTop={1}>
        {actions.map((a, i) => {
          const active = i === cursor;
          const isBusyThis = busy?.actionId === a.id;
          const accentColor = a.danger ? colors.error : colors.accent;
          const labelColor = a.danger ? colors.error : active ? accentColor : colors.fgBright;
          return (
            <Box key={a.id} flexDirection="column" marginBottom={1}>
              <Box flexDirection="row">
                <Box width={2}>
                  <Text color={active ? accentColor : "transparent"} bold>
                    {active ? icons.play : " "}
                  </Text>
                </Box>
                <Box width={2}>
                  <Text color={a.danger ? colors.error : colors.fgSubtle}>{a.icon ?? "·"}</Text>
                </Box>
                <Box flexDirection="column" flexGrow={1}>
                  <Text color={labelColor} bold>
                    {a.label}
                  </Text>
                  {a.desc ? <Text color={colors.fgSubtle}>{a.desc}</Text> : null}
                </Box>
              </Box>
              {active && a.steps && a.steps.length > 0 ? (
                <Box flexDirection="row" marginLeft={4} marginTop={0}>
                  {a.steps.map((s, idx) => {
                    const stateName: "pending" | "running" | "done" = isBusyThis
                      ? idx < busy.stepIdx
                        ? "done"
                        : idx === busy.stepIdx
                          ? "running"
                          : "pending"
                      : "pending";
                    return <StepChip key={s} label={s} state={stateName} />;
                  })}
                </Box>
              ) : null}
              {active && a.hint ? (
                <Box marginLeft={4}>
                  <Text color={toneColor(a.hint.tone)}>
                    {a.hint.icon ?? icons.hook} {a.hint.text}
                  </Text>
                </Box>
              ) : null}
            </Box>
          );
        })}
      </Box>

      {/* Footer hint */}
      <Box marginTop={0} flexDirection="row">
        <Text color={colors.fgBright} bold>
          ↑↓
        </Text>
        <Text color={colors.fgSubtle}> acción </Text>
        <Text color={colors.fgFaint}>·</Text>
        <Text color={colors.fgBright} bold>
          {" "}
          ⏎
        </Text>
        <Text color={colors.fgSubtle}> aplicar </Text>
        <Text color={colors.fgFaint}>·</Text>
        <Text color={colors.fgBright} bold>
          {" "}
          esc
        </Text>
        <Text color={colors.fgSubtle}> cerrar</Text>
        {footerRight ? (
          <>
            <Box flexGrow={1} />
            <Text color={colors.fgMoreSubtle}>{footerRight}</Text>
          </>
        ) : null}
      </Box>
    </Box>
  );
}
