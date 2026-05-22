import { Box, Text } from "ink";
import { HOSTS, type HostMeta, hostMeta } from "../hosts.js";
import { colors } from "../theme.js";

export interface HostChipProps {
  /** id del host del registry */
  id: string;
  /** true = host instalado / activo */
  on?: boolean;
  /** override de display (overrides host.glyph) */
  glyph?: string;
  /** sólo "sm" por defecto en TTY; "md" agrega padding lateral */
  size?: "xs" | "sm" | "md";
}

/**
 * HostChip — glyph compacto de 1 letra que indica un host.
 * En TTY no hay fondos arbitrarios; usamos `backgroundColor` de Ink (que el
 * renderer adapta al terminal) y color de letra. Cuando `on=false` el chip
 * pierde el fill verde y vuelve a hueso (muted).
 */
export function HostChip({ id, on = true, glyph, size = "sm" }: HostChipProps) {
  const meta = hostMeta(id);
  const ch = glyph ?? meta.glyph;
  if (on) {
    return (
      <Text color={colors.success} bold>
        {wrap(ch, size)}
      </Text>
    );
  }
  return (
    <Text color={colors.fgFaint} dimColor>
      {wrap(ch, size)}
    </Text>
  );
}

/**
 * HostChipStrip — todos los hosts del registry como chips, en línea.
 * Los `active` reciben color de "on", el resto queda en "off".
 */
export function HostChipStrip({
  active,
  size = "sm",
  hosts = HOSTS,
}: {
  active: readonly string[];
  size?: "xs" | "sm" | "md";
  hosts?: readonly HostMeta[];
}) {
  const onSet = new Set(active);
  return (
    <Box>
      {hosts.map((h, idx) => (
        <Box key={h.id} marginLeft={idx === 0 ? 0 : 1}>
          <HostChip id={h.id} on={onSet.has(h.id)} size={size} />
        </Box>
      ))}
    </Box>
  );
}

/**
 * Render del chip — en TTY usamos `[X]` para md, `X` solo para sm/xs.
 */
function wrap(ch: string, size: "xs" | "sm" | "md"): string {
  if (size === "md") return `[${ch}]`;
  return ch;
}
