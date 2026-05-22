import { Box, Text } from "ink";
import { useEffect, useRef, useState } from "react";
import { type SelfDoctorReport, selfDoctor } from "../../../application/self/doctor-self.js";
import type { SelfMcpConnectionView } from "../../../application/self/mcp-config.js";
import { selfMcpConfig } from "../../../application/self/mcp-config.js";
import type { ParsedArgs } from "../../parser.js";
import type { CliContext } from "../../types.js";
import { PageHead } from "../components/page-head.js";
import { HOSTS } from "../hosts.js";
import { colors, icons } from "../theme.js";

export interface StatusTabProps {
  ctx: CliContext;
  isActive: boolean;
  onRunAction?: (id: string) => void;
}

interface StatusData {
  doctor: SelfDoctorReport | null;
  mcp: SelfMcpConnectionView[];
  loading: boolean;
}

/**
 * StatusTab — vista general del runtime.
 *
 * Estructura:
 * - PageHead (count: hosts instalados / totales)
 * - Card CLI (versión + paquete)
 * - Card MCP (lista de conexiones registradas)
 * - Card Hosts soportados (grid de host-cards)
 * - Card Skills (installed/total + progress)
 * - Card Plugins (placeholder hasta tener un counter rápido)
 * - Quick actions (install:all, update:check, clean:cache, palette)
 */
export function StatusTab({ ctx }: StatusTabProps) {
  const [data, setData] = useState<StatusData>({ doctor: null, mcp: [], loading: true });
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void (async () => {
      const doc = await selfDoctor(ctx).catch(() => null);
      const mcpRes = await selfMcpConfig(buildArgs("list"), ctx).catch(() => null);
      const mcp: SelfMcpConnectionView[] = mcpRes?.ok ? (mcpRes.data?.connections ?? []) : [];
      setData({ doctor: doc?.ok ? (doc.data ?? null) : null, mcp, loading: false });
    })();
  }, [ctx]);

  if (data.loading) {
    return (
      <Box>
        <Text color={colors.fgSubtle}>{icons.spinner} cargando estado…</Text>
      </Box>
    );
  }

  const installedHosts = data.doctor?.skill.targets.filter((t) => t.installed).length ?? 0;
  const supportedHosts = HOSTS.length;
  const skillTotalBacked = data.doctor?.skill.targets.length ?? 0;

  return (
    <Box flexDirection="column">
      <PageHead
        title="Status"
        count={{
          label: `${installedHosts}/${supportedHosts}`,
          tone: installedHosts > 0 ? "ok" : "muted",
        }}
      />

      <SectionFrame title="CLI">
        <Text color={colors.fgBright} bold>
          v{data.doctor?.cli_version ?? "?"}
        </Text>
        <Text color={colors.fgFaint}> · </Text>
        <Text color={colors.info}>{data.doctor?.runtime.package_name ?? "—"}</Text>
      </SectionFrame>

      <SectionFrame title="MCP">
        {data.mcp.length === 0 ? (
          <Text color={colors.fgFaint}>(ninguna conexión registrada)</Text>
        ) : (
          <Box flexDirection="column">
            {data.mcp.slice(0, 4).map((m) => (
              <Box key={m.nombre}>
                <Text color={colors.accent}>·</Text>
                <Text> </Text>
                <Text color={colors.fgBright}>{m.nombre}</Text>
                <Text color={colors.fgFaint}> </Text>
                <Text color={colors.info}>{m.dsn_var}</Text>
              </Box>
            ))}
          </Box>
        )}
      </SectionFrame>

      <SectionFrame title="Skills">
        <Text color={colors.fgBright}>{installedHosts}</Text>
        <Text color={colors.fgFaint}>/{skillTotalBacked || supportedHosts}</Text>
        <Text> </Text>
        <ProgressLine ratio={skillTotalBacked > 0 ? installedHosts / skillTotalBacked : 0} />
      </SectionFrame>
    </Box>
  );
}

/**
 * SectionFrame — caja con borde fino + título uppercase compacto.
 *
 * Usado para delimitar secciones del Status, Project y otros tabs sin recurrir
 * a uppercase labels sueltos. El border usa `borderFaint` para ser sutil.
 */
function SectionFrame({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={colors.borderFaint}
      paddingX={1}
      marginBottom={1}
    >
      <Text color={colors.fgMoreSubtle}>{title.toUpperCase()}</Text>
      <Box>{children}</Box>
    </Box>
  );
}

function ProgressLine({ ratio }: { ratio: number }) {
  const width = 14;
  const filled = Math.round(Math.max(0, Math.min(1, ratio)) * width);
  return (
    <Box>
      <Text color={colors.accent}>{"█".repeat(filled)}</Text>
      <Text color={colors.fgFaint}>{"░".repeat(width - filled)}</Text>
    </Box>
  );
}

function buildArgs(action: string): ParsedArgs {
  return {
    rest: ["mcp", action],
    plugin: {},
    flags: new Set(),
    values: new Map(),
    valuesMulti: new Map(),
  };
}
