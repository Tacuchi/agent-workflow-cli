// Transitional: la administración por host vive ahora en HostAdminSection
// (montada como sección principal de [Workflows]); este tab la reusa hasta que
// la ronda F4 lo reescriba como administrador de skills sueltas.

import { Box, Text } from "ink";
import { useState } from "react";
import type { CliContext } from "../../types.js";
import { HostAdminSection, type HostAdminSummary } from "../components/host-admin-section.js";
import { PageHead } from "../components/page-head.js";
import { WORKFLOW_CONTENT } from "../data/workflow-content.js";
import { colors } from "../theme.js";

export interface SkillsTabProps {
  ctx: CliContext;
  isActive: boolean;
  version?: string;
  onToast?: (msg: { tone: "ok" | "info" | "err"; title: string; body?: string }) => void;
}

export function SkillsTab({ ctx, isActive, onToast }: SkillsTabProps) {
  const [summary, setSummary] = useState<HostAdminSummary>({
    installed: 0,
    total: 0,
    backed: 0,
    pending: 0,
  });

  return (
    <Box flexDirection="column">
      <PageHead
        title="Skills"
        count={{
          label: `${summary.installed}/${summary.total} hosts · ${subSkillsTotal()} sub-skills · ${WORKFLOW_CONTENT.slashCommands.length} slash commands`,
          tone: summary.installed === 0 ? "warn" : "accent",
        }}
        action={<Text color={colors.mute}>one universal SKILL · agent-workflow</Text>}
      />
      <HostAdminSection
        ctx={ctx}
        isActive={isActive}
        {...(onToast ? { onToast } : {})}
        onSummary={setSummary}
        hooksMetaSuffix={`hooks armed · SKILL + ${WORKFLOW_CONTENT.slashCommands.length} slash + ${WORKFLOW_CONTENT.hooks.length} hooks`}
      />
    </Box>
  );
}

function subSkillsTotal(): number {
  return WORKFLOW_CONTENT.commandFamilies.reduce((n, f) => n + f.items.length, 0);
}
