// [Workflows] — administración por host del bundle `w` como sección principal
// (HostAdminSection) + informativo mínimo: overview de 1 línea y strip compacto
// de flows. Las FamilyCards/PhaseCards se retiraron en esta ronda (el detalle
// doctrinal vive en el propio bundle, no en la TUI).

import { Box, Text } from "ink";
import type { CliContext } from "../../types.js";
import { HostAdminSection } from "../components/host-admin-section.js";
import { PageHead } from "../components/page-head.js";
import { WORKFLOW_CONTENT } from "../data/workflow-content.js";
import { colors } from "../theme.js";

export interface WorkflowTabProps {
  ctx: CliContext;
  isActive: boolean;
  onToast?: (msg: { tone: "ok" | "info" | "err"; title: string; body?: string }) => void;
}

// Ids de los 3 flows dentro de WORKFLOW_CONTENT.phases (excluye bootstrap/export).
const FLOW_IDS: ReadonlySet<string> = new Set(["spec", "plan", "quick"]);

export function WorkflowTab({ ctx, isActive, onToast }: WorkflowTabProps) {
  const w = WORKFLOW_CONTENT;
  const flowNames = w.phases
    .filter((p) => FLOW_IDS.has(p.id))
    .map((p) => p.title.split(" — ")[0] ?? p.title);

  return (
    <Box flexDirection="column">
      <PageHead
        title="Workflows"
        count={{
          label: `${w.slashCommands.length} slash commands · ${w.hooks.length} hooks`,
          tone: "accent",
        }}
        action={<Text color={colors.mute}>stages + loops + artifacts harness</Text>}
      />

      <Box>
        <Text color={colors.dim} wrap="truncate-end">
          {w.overview}
        </Text>
      </Box>
      <Box marginBottom={1}>
        <Text color={colors.mute}>Flows: </Text>
        <Text color={colors.bright} bold>
          {flowNames.join(" · ")}
        </Text>
        <Text color={colors.dim}> — export-* promotes to docs/</Text>
      </Box>

      <HostAdminSection
        ctx={ctx}
        isActive={isActive}
        {...(onToast ? { onToast } : {})}
        hooksMetaSuffix={`hooks armed · SKILL + ${w.slashCommands.length} slash + ${w.hooks.length} hooks`}
      />
    </Box>
  );
}
