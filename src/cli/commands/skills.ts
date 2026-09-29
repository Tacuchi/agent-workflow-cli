import { resolveSkills } from "../../application/skills-resolver-service.js";
import type { ResolvedSkills } from "../../domain/skills.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { CliCommand, HumanRenderContext } from "../registry.js";
import type { CliContext } from "../types.js";

interface SkillsData {
  skills: ResolvedSkills;
  sources: { global: boolean; workspace: boolean };
  warnings: string[];
}

export const skillsCommand: CliCommand<SkillsData> = {
  name: "skills",
  flags: { known: [] },
  describe:
    "Diagnóstico de bindings propios del bundle (skills.toml). Usage: aw skills [--detail].",

  async execute(_args: ParsedArgs, ctx: CliContext): Promise<CommandResult<SkillsData>> {
    const resolution = await resolveSkills(ctx.fs, ctx.paths);
    const data: SkillsData = {
      skills: resolution.skills,
      sources: resolution.sources,
      warnings: resolution.warnings,
    };
    return { ok: true, data, exitCode: 0 };
  },

  /**
   * The human projection of the SAME data. Nothing is re-derived: every line
   * reads a field the structured form also carries, so the two cannot disagree.
   */
  renderHuman(result: CommandResult<SkillsData>, _context: HumanRenderContext): string {
    const data = result.data;
    if (data === undefined) return "";
    const lines: string[] = [];
    for (const [role, resolved] of Object.entries(data.skills)) {
      const bound = resolved.enabled ? resolved.skill : "off";
      lines.push(`${role.padEnd(10)} ${String(bound).padEnd(14)} (${resolved.source})`);
    }
    for (const warning of data.warnings) lines.push(`aviso: ${warning}`);
    return `${lines.join("\n")}\n`;
  },
};
