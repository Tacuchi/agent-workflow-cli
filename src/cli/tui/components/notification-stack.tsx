import { Box, Text } from "ink";
import type { NotificationItem } from "../notification-center.js";
import { colors } from "../theme.js";
import { NotificationBanner, notificationBannerRows } from "./notification-banner.js";

export interface NotificationStackProps {
  items: NotificationItem[];
  /** Max items visible at once (newest first). Default 3. */
  max?: number;
}

/**
 * Exact row count the stack occupies for `items` — 0 when empty; otherwise the
 * per-banner heights of the visible slice + the `+N more` overflow line + the
 * container's marginBottom. Windowed lists add this to their `reservedRows` so
 * a visible banner can't clip the list's bottom rows. WARNING: the math
 * mirrors the JSX below — keep both in sync (banner heights live in
 * `notificationBannerRows`).
 */
export function notificationStackRows(items: NotificationItem[], max = 3): number {
  if (items.length === 0) return 0;
  const visible = items.slice(-max);
  const overflow = items.length - visible.length;
  const bannerRows = visible.reduce((sum, item) => sum + notificationBannerRows(item), 0);
  return bannerRows + (overflow > 0 ? 1 : 0) + 1; // +1 = marginBottom
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
