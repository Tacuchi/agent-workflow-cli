import type { CliContext } from "../../cli/types.js";
import type { CommandResult } from "../../domain/types.js";

export interface SelfInstallSkillData {
  status: "deferred";
  reason: string;
  manual_install: string;
}

export async function selfInstallSkill(
  _ctx: CliContext,
): Promise<CommandResult<SelfInstallSkillData>> {
  return {
    ok: true,
    data: {
      status: "deferred",
      reason: "self install-skill is delivered in sub-project 2 (separate skill repo).",
      manual_install:
        "Until sub-project 2 ships, install manually by cloning the skill repo into ~/.claude/skills/agent-workflow/",
    },
    exitCode: 0,
  };
}
