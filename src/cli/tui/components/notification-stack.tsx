import { Box, Text } from "ink";
import type { NotificationItem } from "../notification-center.js";
import { colors } from "../theme.js";
import { NotificationBanner } from "./notification-banner.js";

export interface NotificationStackProps {
  items: NotificationItem[];
  /** Max items visible at once (newest first). Default 3. */
  max?: number;
}

/**
 * NotificationStack — renders the NotificationCenter's item array.
 *
 * Lives between `HomeHeader` and `TabBar`. When `items` is empty it renders
 * nothing (full collapse — occupies no rows).
 *
 * With more than `max` items, it shows the `max` newest ones and a `+N more`
 * counter below to signal the overflow.
 */
export function NotificationStack({ items, max = 3 }: NotificationStackProps) {
  if (items.length === 0) return null;
  const visible = items.slice(-max).reverse();
  const overflow = items.length - visible.length;
  return (
    <Box flexDirection="column" marginBottom={1}>
      {visible.map((item) => (
        <NotificationBanner key={item.id} item={item} />
      ))}
      {overflow > 0 ? (
        <Box marginLeft={2}>
          <Text color={colors.faint}>+{overflow} more</Text>
        </Box>
      ) : null}
    </Box>
  );
}
