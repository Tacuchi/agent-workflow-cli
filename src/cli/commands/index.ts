// Canonical list of every CLI command. This is the single source of truth for
// "which commands exist": the help grouping guard test asserts each of these has
// a real home in help-groups.ts (none fall into the catch-all "Other"), the
// global-help describe map is built from it, and `main.ts` registers this array
// directly (order here = order in the grouped `--help` listing).

import type { CliCommand } from "../registry.js";
import { addSourceCommand } from "./add-source.js";
import { amendCommand } from "./amend.js";
import { checkBranchCommand } from "./check-branch.js";
import { checkpointReadCommand } from "./checkpoint-read.js";
import { checkpointWriteCommand } from "./checkpoint-write.js";
import { claimsCommand } from "./claims.js";
import { codeScanCommand } from "./code-scan.js";
import { contextBudgetCommand } from "./context-budget.js";
import { contextPlanCommand } from "./context-plan.js";
import { cutIntentCommand } from "./cut-intent.js";
import { harnessCommand, logsCommand, nextNumberCommand, profilesCommand } from "./dev-only.js";
import { docBranchCommand } from "./doc-branch.js";
import { doctorCommand } from "./doctor.js";
import {
  exportDiagramsCommand,
  exportManualsCommand,
  exportReportsCommand,
  exportScriptsCommand,
} from "./export.js";
import { flowCommand } from "./flow.js";
import { gitFlowCommand } from "./git-flow.js";
import { historyUpdateCommand } from "./history-update.js";
import { historyCommand } from "./history.js";
import { hookCommand } from "./hook.js";
import { hostDoctorCommand } from "./host-doctor.js";
import { hostMemoryCommand } from "./host-memory.js";
import { hubBlockUpsertCommand } from "./hub-block.js";
import { hubCommitCommand } from "./hub-commit.js";
import { hubInitCommand } from "./hub-init.js";
import { hubMigrateCommand } from "./hub-migrate.js";
import { hubMoveCommand } from "./hub-move.js";
import { mcpCommand } from "./mcp.js";
import { mergeStateCommand } from "./merge-state.js";
import { attachMultirootCommand, detachMultirootCommand } from "./multiroot.js";
import { persistCommand } from "./persist.js";
import { planCommand } from "./plan.js";
import { pluginDoctorCommand } from "./plugin-doctor.js";
import { releaseDataCommand } from "./release-data.js";
import { releasePassCommand } from "./release-pass.js";
import { removeSourceCommand } from "./remove-source.js";
import { resealCommand } from "./reseal.js";
import { resumeCommand } from "./resume.js";
import { discardCommand, resetCommand } from "./retirement.js";
import { selfCommand } from "./self.js";
import { sessionArtifactsCommand } from "./session-artifacts.js";
import { sessionCloseCommand } from "./session-close.js";
import { sessionCreateCommand } from "./session-create.js";
import { sessionLoadCommand } from "./session-load.js";
import { sessionPauseCommand } from "./session-pause.js";
import { sessionsCommand } from "./sessions.js";
import {
  setExceptionBranchCommand,
  setQaBranchCommand,
  setWorkingBranchCommand,
} from "./set-branch.js";
import { setEditModeCommand } from "./set-edit-mode.js";
import { setPipelineCommand } from "./set-pipeline.js";
import { settleCommand } from "./settle.js";
import { skillsCommand } from "./skills.js";
import { sourcesCommand } from "./sources.js";
import { stackCommand } from "./stack.js";
import { statusCommand } from "./status.js";
import { toolCommand } from "./tool.js";
import { visibilityCommand } from "./visibility.js";
import { worktreeCommand } from "./worktree.js";

export const ALL_COMMANDS: readonly CliCommand[] = [
  sessionsCommand,
  statusCommand,
  resumeCommand,
  hostMemoryCommand,
  persistCommand,
  exportDiagramsCommand,
  exportManualsCommand,
  exportReportsCommand,
  exportScriptsCommand,
  historyCommand,
  historyUpdateCommand,
  sessionArtifactsCommand,
  sessionCloseCommand,
  sessionCreateCommand,
  sessionPauseCommand,
  stackCommand,
  hubInitCommand,
  hubCommitCommand,
  hubMoveCommand,
  addSourceCommand,
  contextBudgetCommand,
  contextPlanCommand,
  skillsCommand,
  flowCommand,
  sourcesCommand,
  docBranchCommand,
  setWorkingBranchCommand,
  setQaBranchCommand,
  setExceptionBranchCommand,
  setEditModeCommand,
  setPipelineCommand,
  removeSourceCommand,
  gitFlowCommand,
  mergeStateCommand,
  checkpointReadCommand,
  checkBranchCommand,
  checkpointWriteCommand,
  hookCommand,
  mcpCommand,
  toolCommand,
  visibilityCommand,
  worktreeCommand,
  harnessCommand,
  profilesCommand,
  logsCommand,
  claimsCommand,
  // The one place a human intention enters the hub: how a cut of plans
  // born from one spec was meant to be executed. Everything that orders the
  // board derives from it, so it is declared here and nowhere else.
  cutIntentCommand,
  // The production axis the board never had: a pass is its own object, and
  // 'closed' is not 'released'. It sits beside cut-intent because the two are
  // the only facts a person declares into the hub by hand.
  releasePassCommand,
  nextNumberCommand,
  // Retirement: the two cross-cutting commands that take work away. They open no
  // flow and create no session, because a retirement can end by deleting the very
  // session that drove it.
  discardCommand,
  resetCommand,
  // The cheap exit a legitimate baseline divergence has: re-sealing a plan whose
  // review concluded it still holds, instead of walking a whole plan-refine to
  // make the publication recompute one line.
  resealCommand,
  amendCommand,
  settleCommand,
  // The whole plan grammar without a run: what publication and the execution
  // entry would each refuse, listed at once.
  planCommand,
  codeScanCommand,
  pluginDoctorCommand,
  hostDoctorCommand,
  doctorCommand,
  releaseDataCommand,
  attachMultirootCommand,
  detachMultirootCommand,
  hubBlockUpsertCommand,
  // The punctual way into the current model for a hub that carries a legacy
  // series. Read-only without `--apply`.
  hubMigrateCommand,
  sessionLoadCommand,
  selfCommand,
];
