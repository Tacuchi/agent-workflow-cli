import { Box, Text } from "ink";
import type { NotificationItem, NotificationTone } from "../notification-center.js";
import { colors, icons } from "../theme.js";

const TONE_COLOR: Record<NotificationTone, string> = {
  ok: colors.ok,
  info: colors.info,
  warn: colors.warn,
  err: colors.err,
};

const TONE_ICON: Record<NotificationTone, string> = {
  ok: icons.check,
  info: icons.bullet,
  warn: icons.refresh,
  err: icons.cross,
};

export interface NotificationBannerProps {
  item: NotificationItem;
}

/**
 * NotificationBanner — render visual de un item del NotificationCenter.
 *
 * Layout horizontal:
 *   ▎ <tone-icon> <title>                   <CTA primaria> <hints dim>
 *                 <body opcional, dim>
 *
 * Si el item tiene acciones, la primera (o la que tenga `emphasis: true`) se
 * resalta como `inverse bold`. El resto se muestra `dim` con la convención
 * `key label · key label`. Si `dismissible !== false`, se anexa `x dismiss`.
 */
export function NotificationBanner({ item }: NotificationBannerProps) {
  const toneColor = TONE_COLOR[item.tone];
  const toneIcon = TONE_ICON[item.tone];
  const actions = item.actions ?? [];
  const dismissible = item.dismissible !== false;

  // CTA primaria: la primera acción con emphasis, o la primera del array.
  const primaryIdx = actions.findIndex((a) => a.emphasis);
  const primary = primaryIdx >= 0 ? actions[primaryIdx] : actions[0];
  const rest = actions.filter((a) => a !== primary);

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color={toneColor}>{icons.focusBar}</Text>
        <Text> </Text>
        <Text color={toneColor}>{toneIcon}</Text>
        <Text> </Text>
        <Box flexGrow={1}>
          {typeof item.title === "string" ? (
            <Text color={colors.bright} bold>
              {item.title}
            </Text>
          ) : (
            item.title
          )}
        </Box>
        {primary ? (
          <Box marginLeft={1}>
            <Text color={colors.accent} bold inverse>
              {` ${primary.key} · ${primary.label} `}
            </Text>
          </Box>
        ) : null}
        {rest.length > 0 || dismissible ? (
          <Box marginLeft={1}>
            <Text color={colors.mute}>
              {rest.map((a, idx) => (
                <Text key={`${a.key}-${a.label}`}>
                  {idx > 0 ? " · " : ""}
                  <Text color={colors.accent}>{a.key}</Text>
                  <Text color={colors.mute}> {a.label}</Text>
                </Text>
              ))}
              {dismissible ? (
                <>
                  {rest.length > 0 ? <Text color={colors.mute}> · </Text> : null}
                  <Text color={colors.accent}>x</Text>
                  <Text color={colors.mute}> dismiss</Text>
                </>
              ) : null}
            </Text>
          </Box>
        ) : null}
      </Box>
      {item.body ? (
        <Box marginLeft={4}>
          <Text color={colors.dim}>{item.body}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
