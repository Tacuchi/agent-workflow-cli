// Canonical list of every CLI command. This is the single source of truth for
// "which commands exist": the help grouping guard test asserts each of these has
// a real home in help-groups.ts (none fall into the catch-all "Other"), and the
// global-help describe map is built from it. `main.ts` registers exactly this
// set — keep the two in sync (the `help-groups` guard test fails otherwise).

import type { QtcCommand } from "../registry.js";
import { bootstrapDsnCommand } from "./bootstrap-dsn.js";
import { checkBranchCommand } from "./check-branch.js";
import { checkpointReadCommand } from "./checkpoint-read.js";
import { autoCompactOnCloseCommand, checkpointWriteCommand } from "./checkpoint-write.js";
import { codeScanCommand } from "./code-scan.js";
import { compressCheckpointCommand } from "./compress-checkpoint.js";
import { harnessCommand, logsCommand, nextNumberCommand, profilesCommand } from "./dev-only.js";
import { gitFlowCommand } from "./git-flow.js";
import { historyDataCommand } from "./history-data.js";
import { historyUpdateCommand } from "./history-update.js";
import { hookCommand } from "./hook.js";
import { hostDoctorCommand } from "./host-doctor.js";
import { mcpCommand } from "./mcp.js";
import { mergeStateCommand } from "./merge-state.js";
import { attachMultirootCommand, detachMultirootCommand } from "./multiroot.js";
import { pluginCacheCommand } from "./plugin-cache.js";
import { pluginDoctorCommand } from "./plugin-doctor.js";
import { projectMdUpsertCommand } from "./project-md-upsert.js";
import { releaseDataCommand } from "./release-data.js";
import { removeSourceCommand } from "./remove-source.js";
import { resumeSummaryCommand } from "./resume-summary.js";
import { selfCommand } from "./self.js";
import { sessionArtifactsCommand } from "./session-artifacts.js";
import { sessionCloseCommand } from "./session-close.js";
import { sessionCreateCommand } from "./session-create.js";
import { sessionResumeCommand } from "./session-resume.js";
import { sessionsCommand } from "./sessions.js";
import { setQaBranchCommand } from "./set-qa-branch.js";
import { setWorkingBranchCommand } from "./set-working-branch.js";
import { skillIndexCommand } from "./skill-index.js";
import { skillsCommand } from "./skills.js";
import { sourcesCommand } from "./sources.js";
import { stackCommand } from "./stack.js";
import { statusCommand } from "./status.js";
import { visibilityCommand } from "./visibility.js";
import { workspaceInitCommand } from "./workspace-init.js";

export const ALL_COMMANDS: readonly QtcCommand[] = [
  sessionsCommand,
  statusCommand,
  historyDataCommand,
  historyUpdateCommand,
  sessionArtifactsCommand,
  sessionCloseCommand,
  sessionCreateCommand,
  stackCommand,
  workspaceInitCommand,
  skillIndexCommand,
  skillsCommand,
  sourcesCommand,
  setWorkingBranchCommand,
  setQaBranchCommand,
  removeSourceCommand,
  gitFlowCommand,
  mergeStateCommand,
  checkpointReadCommand,
  resumeSummaryCommand,
  compressCheckpointCommand,
  checkBranchCommand,
  checkpointWriteCommand,
  autoCompactOnCloseCommand,
  hookCommand,
  mcpCommand,
  visibilityCommand,
  harnessCommand,
  profilesCommand,
  logsCommand,
  nextNumberCommand,
  bootstrapDsnCommand,
  codeScanCommand,
  pluginCacheCommand,
  pluginDoctorCommand,
  hostDoctorCommand,
  releaseDataCommand,
  attachMultirootCommand,
  detachMultirootCommand,
  projectMdUpsertCommand,
  sessionResumeCommand,
  selfCommand,
];

/** name → describe map for the global `aw --help` command list. */
export function commandDescribes(): ReadonlyMap<string, string> {
  return new Map(ALL_COMMANDS.map((c) => [c.name, c.describe ?? ""]));
}
