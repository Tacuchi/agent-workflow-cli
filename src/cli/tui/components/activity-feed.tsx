import { Box, Text } from "ink";
import { colors } from "../theme.js";

export type ActivityTone = "ok" | "accent" | "info" | "purple" | "warn" | "err" | "dim";

export interface ActivityEvent {
  id: string;
  when: string;
  dotColor: ActivityTone;
  text: string;
  meta?: string;
  metaTone?: ActivityTone;
}

export interface ActivityFeedProps {
  events: ActivityEvent[];
  cap?: number;
  emptyHint?: string;
}

const MAX_TEXT_LENGTH = 80;

function tone(t: ActivityTone): string {
  switch (t) {
    case "ok":
      return colors.ok;
    case "accent":
      return colors.accent;
    case "info":
      return colors.info;
    case "purple":
      return colors.purple;
    case "warn":
      return colors.warn;
    case "err":
      return colors.err;
    case "dim":
      return colors.dim;
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

export function ActivityFeed({ events, cap, emptyHint }: ActivityFeedProps) {
  const list = cap ? events.slice(0, cap) : events;
  if (!list.length) {
    return <Text color={colors.faint}>{emptyHint ?? "  (no recent activity)"}</Text>;
  }
  return (
    <Box flexDirection="column">
      {list.map((e) => (
        <Box key={e.id}>
          <Box width={10} flexShrink={0}>
            <Text color={colors.dim} wrap="truncate-end">
              {e.when}
            </Text>
          </Box>
          <Text color={tone(e.dotColor)}>● </Text>
          <Text color={colors.text}>{truncate(e.text, MAX_TEXT_LENGTH)}</Text>
          {e.meta ? (
            <>
              <Box flexGrow={1}>
                <Text> </Text>
              </Box>
              <Text color={tone(e.metaTone ?? "dim")}>{e.meta}</Text>
            </>
          ) : null}
        </Box>
      ))}
    </Box>
  );
}
