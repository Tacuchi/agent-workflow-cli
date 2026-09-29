// [Workline] — per-host administration of the `w` bundle as the main section
// (HostAdminSection) + minimal info: a 1-line overview and a compact flows
// strip. Doctrinal detail lives in the bundle itself, not in the TUI.

import { Box, Text } from "ink";
import type { CliContext } from "../../types.js";
import { HostAdminSection } from "../components/host-admin-section.js";
import { PageHead } from "../components/page-head.js";
import { WORKFLOW_CONTENT } from "../data/workflow-content.js";
import type { ToastBridgeInput } from "../notification-center.js";
import type { PublicStatusSummary } from "../public-status.js";
import { colors } from "../theme.js";

export interface WorkflowTabProps {
  ctx: CliContext;
  isActive: boolean;
  summary?: PublicStatusSummary | null;
  onToast?: (msg: ToastBridgeInput) => void;
  /** Hosts [Config] turned off — they leave this tab's host list. */
  disabledHosts?: readonly string[];
}

// Ids of the 3 flows inside WORKFLOW_CONTENT.phases (excludes bootstrap/export).
const FLOW_IDS: ReadonlySet<string> = new Set(["spec", "plan", "quick"]);

export function WorkflowTab({ ctx, isActive, summary, onToast, disabledHosts }: WorkflowTabProps) {
  const w = WORKFLOW_CONTENT;
  const flowNames = w.phases
    .filter((p) => FLOW_IDS.has(p.id))
    .map((p) => p.title.split(" — ")[0] ?? p.title);

  return (
    <Box flexDirection="column">
      <PageHead
        title="Workline"
        // These are the BUNDLE's contents, not a promise about every host: the
        // command surface and the hooks differ per host, and each host's row
        // below states what it actually exposes.
        count={{
          label: `bundle: ${w.slashCommands.length} commands · ${w.hooks.length} hooks`,
          tone: "accent",
        }}
        action={<Text color={colors.mute}>per-host surface shown on each row</Text>}
      />

      <Box>
        <Text color={colors.dim} wrap="truncate-end">
          {w.overview}
        </Text>
      </Box>
      <Box>
        <Text color={colors.mute}>Next: </Text>
        <Text color={colors.dim} wrap="truncate-end">
          {summary?.next ?? "no disponible"}
        </Text>
      </Box>
      <Box>
        <Text color={colors.mute}>Flows: </Text>
        <Text color={colors.bright} bold>
          {flowNames.join(" · ")}
        </Text>
        <Text color={colors.dim}> — export-* promotes to docs/</Text>
      </Box>
      {/* The identity and the count never shrink: ink shrinks flex children by
          default, which truncated `aw flow` to `aw flo` and swallowed the label's
          trailing space. Only the summary may be elided. */}
      <Box marginBottom={1}>
        <Box flexShrink={0}>
          <Text color={colors.mute}>Engine: </Text>
          <Text color={colors.bright} bold>
            {w.engine.command}
          </Text>
          <Text
            color={colors.dim}
          >{` — ${summary?.state === "available" ? `${summary.pending} pendientes` : "estado no disponible"} · `}</Text>
        </Box>
        <Text color={colors.dim} wrap="truncate-end">
          {w.engine.summary}
        </Text>
      </Box>

      <HostAdminSection
        ctx={ctx}
        isActive={isActive}
        {...(onToast ? { onToast } : {})}
        {...(disabledHosts ? { disabledHosts } : {})}
        // "template" and not "hooks", because how many of them a host really
        // carries is what the host row itself reports.
        hooksMetaSuffix={`hooks armed · SKILL + ${w.slashCommands.length} slash + ${w.hooks.length} template hooks`}
      />
    </Box>
  );
}
