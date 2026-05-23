import { Box, Text } from "ink";
import type { CliContext } from "../../types.js";
import { FamilyCard } from "../components/family-card.js";
import { FrameBox } from "../components/frame-box.js";
import { PageHead } from "../components/page-head.js";
import { PhaseCard } from "../components/phase-card.js";
import { WORKFLOW_CONTENT } from "../data/workflow-content.js";
import { colors, icons } from "../theme.js";

export interface WorkflowTabProps {
  ctx: CliContext;
  isActive: boolean;
}

function chunk<T>(arr: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

export function WorkflowTab(_props: WorkflowTabProps) {
  const w = WORKFLOW_CONTENT;
  const totalCmds = w.commandFamilies.reduce((n, f) => n + f.items.length, 0);

  return (
    <Box flexDirection="column">
      <PageHead
        title="Workflow"
        count={{
          label: `${totalCmds} cmds · ${w.commandFamilies.length} families`,
          tone: "muted",
        }}
      />
      <Text color={colors.fgSubtle}>{w.overview}</Text>

      {/* Lifecycle (5 phases in horizontal row) */}
      <Box marginTop={1} flexDirection="column">
        <FrameBox title="session lifecycle" accent>
          <Text color={colors.fgSubtle}>
            Cómo se usa el harness día a día — cada fase ejecuta comandos del CLI y dispara hooks.
          </Text>
          <Box marginTop={1} flexDirection="row">
            {w.phases.map((p) => (
              <PhaseCard key={p.id} phase={p} />
            ))}
          </Box>
        </FrameBox>
      </Box>

      {/* Command families (3-col grid) */}
      <FrameBox title={`command families · ${w.commandFamilies.length} · ${totalCmds} subcommands`}>
        <Text color={colors.fgSubtle}>
          Todos invocables como <Text color={colors.accent}>agent-workflow &lt;cmd&gt;</Text> ·
          alias <Text color={colors.accent}>aw</Text>.
        </Text>
        <Box flexDirection="column" marginTop={1}>
          {chunk(w.commandFamilies, 3).map((row) => (
            <Box key={`fam-row-${row[0]?.id ?? "empty"}`} flexDirection="row">
              {row.map((f) => (
                <FamilyCard key={f.id} family={f} />
              ))}
            </Box>
          ))}
        </Box>
      </FrameBox>

      {/* Slash + Hooks side-by-side */}
      <Box flexDirection="row">
        <Box flexDirection="column" flexGrow={1} marginRight={1}>
          <FrameBox title={`slash commands · ${w.slashCommands.length}`}>
            <Text color={colors.fgSubtle}>
              Invocables desde Claude Code / Codex como{" "}
              <Text color={colors.accent}>/agent-workflow:&lt;nombre&gt;</Text>.
            </Text>
            <Box marginTop={1} flexDirection="column">
              {w.slashCommands.map((s) => (
                <Text key={s} color={colors.fg}>
                  · {s.replace("/agent-workflow:", "")}
                </Text>
              ))}
            </Box>
          </FrameBox>
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          <FrameBox title={`hooks · ${w.hooks.length} events`}>
            <Text color={colors.fgSubtle}>
              Solo Claude · JSON merge en <Text color={colors.accent}>~/.claude/settings.json</Text>
              .
            </Text>
            <Box marginTop={1} flexDirection="column">
              {w.hooks.map((h) => (
                <Box key={h.name} flexDirection="column" marginBottom={1}>
                  <Box flexDirection="row">
                    <Text color={colors.fgBright} bold>
                      {h.name}
                    </Text>
                    <Text color={colors.fgSubtle}> · matcher: </Text>
                    <Text color={colors.warning}>{h.matcher}</Text>
                  </Box>
                  <Text color={colors.fgSubtle} wrap="wrap">
                    {icons.hook} {h.fires}
                  </Text>
                </Box>
              ))}
            </Box>
          </FrameBox>
        </Box>
      </Box>

      {/* Footer hint */}
      <Box
        borderStyle="round"
        borderColor={colors.borderFaint}
        paddingX={1}
        marginBottom={1}
        flexDirection="row"
      >
        <Text color={colors.accent}>{icons.star} </Text>
        <Text color={colors.fgSubtle}>
          Quick start: <Text color={colors.accent}>aw self install --target claude</Text> · luego
          desde Claude: <Text color={colors.accent}>/agent-workflow:session</Text>
        </Text>
      </Box>
    </Box>
  );
}
