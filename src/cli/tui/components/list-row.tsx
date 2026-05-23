import { Box, Text } from "ink";
import { colors, icons } from "../theme.js";

export type MetaTone = "ok" | "warn" | "accent" | "dim" | "err";

export interface MetaChip {
  label: string;
  tone?: MetaTone;
}

export interface StatePill {
  label: string;
  tone?: MetaTone;
}

export interface ListRowProps {
  icon?: string;
  iconActive?: boolean;
  title: string;
  subtitle?: string;
  meta?: MetaChip[];
  state?: StatePill;
  chevron?: boolean;
  active?: boolean;
  last?: boolean;
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

function Chip({ label, tone }: MetaChip) {
  return (
    <Box marginRight={1}>
      <Text color={toneColor(tone)}>[{label}]</Text>
    </Box>
  );
}

export function ListRow({
  icon = icons.plug,
  iconActive = false,
  title,
  subtitle,
  meta = [],
  state,
  chevron = false,
  active = false,
}: ListRowProps) {
  const cursor = active ? icons.play : " ";
  const iconColor = iconActive ? colors.accent : colors.fgSubtle;
  const titleColor = active ? colors.accent : colors.fgBright;

  return (
    <Box flexDirection="row" paddingX={0}>
      <Box width={2}>
        <Text color={colors.accent} bold>
          {cursor}
        </Text>
      </Box>
      <Box width={3}>
        <Text color={iconColor}>{icon}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} minWidth={0}>
        <Text color={titleColor} bold={active}>
          {title}
        </Text>
        {subtitle ? <Text color={colors.fgSubtle}>{subtitle}</Text> : null}
      </Box>
      {meta.length > 0 ? (
        <Box flexDirection="row" marginX={1}>
          {meta.map((m, i) => (
            <Chip key={`${m.label}-${i}`} {...m} />
          ))}
        </Box>
      ) : null}
      {state ? (
        <Box marginRight={1}>
          <Text color={toneColor(state.tone)} bold>
            {state.label}
          </Text>
        </Box>
      ) : null}
      {chevron ? (
        <Box width={2}>
          <Text color={colors.fgSubtle}>{icons.chevron}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
