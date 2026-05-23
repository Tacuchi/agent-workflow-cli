import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { CliContext } from "../../types.js";
import { FamilyCard } from "../components/family-card.js";
import { PageHead } from "../components/page-head.js";
import { PhaseCard } from "../components/phase-card.js";
import { QuickActions } from "../components/quick-actions.js";
import { SectionHead } from "../components/section-head.js";
import { WORKFLOW_CONTENT } from "../data/workflow-content.js";
import { colors } from "../theme.js";

export interface WorkflowTabProps {
  ctx: CliContext;
  isActive: boolean;
  /** Phase activa (1-based) inferida desde la sesión activa. 0 = idle. */
  activePhase?: number;
}

export function WorkflowTab({ isActive, activePhase = 0 }: WorkflowTabProps) {
  const w = WORKFLOW_CONTENT;

  const [cursor, setCursor] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(w.commandFamilies[0]?.id ?? null);

  useInput(
    (_input, key) => {
      if (!isActive) return;
      if (key.upArrow) {
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.downArrow) {
        setCursor((c) => Math.min(w.commandFamilies.length - 1, c + 1));
        return;
      }
      if (key.return) {
        const fam = w.commandFamilies[cursor];
        if (fam) setExpandedId((prev) => (prev === fam.id ? null : fam.id));
      }
    },
    { isActive },
  );

  return (
    <Box flexDirection="column">
      <PageHead
        title="Workflow"
        count={{
          label: `${w.slashCommands.length} commands · ${w.commandFamilies.length} families · ${w.hooks.length} hooks`,
          tone: "accent",
        }}
        action={<Text color={colors.mute}>universal session-lifecycle harness</Text>}
      />

      {/* 2-column body: lifecycle left, families+slash/hooks right */}
      <Box flexDirection="row">
        <Box flexDirection="column" flexGrow={1} paddingRight={2}>
          <SectionHead label="Session lifecycle" rightAction="day-to-day flow" />
          <Box marginTop={0} flexDirection="column">
            {w.phases.map((p) => (
              <PhaseCard key={p.id} phase={p} active={activePhase === p.n} />
            ))}
          </Box>
        </Box>

        <Box flexDirection="column" flexGrow={1} paddingLeft={1}>
          <SectionHead
            label="Command families"
            count={w.commandFamilies.length}
            rightAction="↵ to expand"
          />
          <Box marginTop={0} flexDirection="column">
            {w.commandFamilies.map((f, i) => (
              <FamilyCard
                key={f.id}
                family={f}
                active={i === cursor}
                expanded={expandedId === f.id}
              />
            ))}
            {w.commandFamilies.length > 8 ? (
              <Text color={colors.faint}>…+{w.commandFamilies.length - 8} more families</Text>
            ) : null}
          </Box>

          <SectionHead label="Slash · Hooks" rightAction="claude · codex" marginTop={1} />
          <Box marginLeft={2} marginTop={0} flexDirection="column">
            <Box>
              <Text color={colors.bright} bold>
                {w.slashCommands.length}
              </Text>
              <Text color={colors.dim}> slash commands · </Text>
              <Text color={colors.accent}>/agent-workflow:&lt;name&gt;</Text>
            </Box>
            <Box flexWrap="wrap">
              <Text color={colors.bright} bold>
                {w.hooks.length}
              </Text>
              <Text color={colors.dim}> hooks · </Text>
              {w.hooks.map((h, i) => (
                <Box key={h.name}>
                  {i > 0 ? <Text color={colors.dim}>, </Text> : null}
                  <Text color={colors.ok}>{h.name}</Text>
                </Box>
              ))}
            </Box>
          </Box>
        </Box>
      </Box>

      <Box marginTop={1}>
        <QuickActions
          actions={[
            { key: "⏎", label: "expand" },
            { key: "^K", label: "palette" },
          ]}
        />
      </Box>
    </Box>
  );
}
