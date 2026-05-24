import { Box, Text } from "ink";
import type { NotificationItem } from "../notification-center.js";
import { colors } from "../theme.js";
import { NotificationBanner } from "./notification-banner.js";

export interface NotificationStackProps {
  items: NotificationItem[];
  /** Máximo de items visibles a la vez (los más nuevos primero). Default 3. */
  max?: number;
}

/**
 * NotificationStack — render del array de items del NotificationCenter.
 *
 * Vive entre `HomeHeader` y `TabBar`. Cuando `items` está vacío, no rinde nada
 * (collapse total — no ocupa filas).
 *
 * Si hay más de `max` items, muestra los `max` más nuevos y un contador
 * `+N more` debajo para señalizar el overflow.
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
