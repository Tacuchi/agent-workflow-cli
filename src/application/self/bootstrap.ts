import type { ParsedArgs } from "../../cli/parser.js";
import type { CliContext } from "../../cli/types.js";
import type { CommandResult } from "../../domain/types.js";
import { type SelfDoctorReport, selfDoctor } from "./doctor-self.js";
import {
  type SelfInstallSkillData,
  type SelfInstallTargetResult,
  selfInstallSkill,
} from "./install-skill.js";
import { type SelfUninstallSkillData, selfUninstallSkill } from "./uninstall-skill.js";

export interface BootstrapStep {
  name: "doctor" | "uninstall-legacy" | "install-skill" | "next-steps";
  status: "ok" | "skipped" | "error";
  data?: unknown;
  message?: string;
}

export interface BootstrapNextStep {
  harness: "claude-code" | "codex";
  detected: boolean;
  install_command: string;
  description: string;
}

export interface SelfBootstrapData {
  steps: BootstrapStep[];
  next_steps: BootstrapNextStep[];
  summary: string;
}

export async function selfBootstrap(
  args: ParsedArgs,
  ctx: CliContext,
): Promise<CommandResult<SelfBootstrapData>> {
  const dryRun = args.flags.has("--dry-run");
  const steps: BootstrapStep[] = [];

  const doctorResult = await selfDoctor(ctx);
  if (!doctorResult.ok || !doctorResult.data) {
    steps.push({
      name: "doctor",
      status: "error",
      message: doctorResult.error?.message ?? "unknown doctor error",
    });
    return failedResult(steps, "doctor failed; aborted bootstrap");
  }
  const doctorData: SelfDoctorReport = doctorResult.data;
  steps.push({ name: "doctor", status: "ok", data: doctorData.skill });

  const hasLegacy = doctorData.skill.targets.some((t) => t.legacy_leftover === true);
  if (hasLegacy) {
    const uninstallArgs = buildUninstallArgs(dryRun);
    const uninstallResult = await selfUninstallSkill(uninstallArgs, ctx);
    if (!uninstallResult.ok || !uninstallResult.data) {
      steps.push({
        name: "uninstall-legacy",
        status: "error",
        message: uninstallResult.error?.message ?? "unknown uninstall error",
      });
      return failedResult(steps, "uninstall-legacy failed; aborted bootstrap");
    }
    const uninstallData: SelfUninstallSkillData = uninstallResult.data;
    steps.push({ name: "uninstall-legacy", status: "ok", data: uninstallData });
  } else {
    steps.push({ name: "uninstall-legacy", status: "skipped", message: "no legacy leftover" });
  }

  const installArgs = buildInstallArgs(dryRun);
  const installResult = await selfInstallSkill(installArgs, ctx);
  if (!installResult.ok || !installResult.data) {
    steps.push({
      name: "install-skill",
      status: "error",
      message: installResult.error?.message ?? "unknown install error",
    });
    return failedResult(steps, "install-skill failed; aborted bootstrap");
  }
  const installData: SelfInstallSkillData = installResult.data;
  steps.push({ name: "install-skill", status: "ok", data: installData });

  const nextSteps = buildNextSteps(installData.dests);
  steps.push({ name: "next-steps", status: "ok", data: nextSteps });

  const summary = composeSummary(steps, nextSteps);
  return {
    ok: true,
    data: {
      steps,
      next_steps: nextSteps,
      summary,
    },
    exitCode: 0,
  };
}

function buildUninstallArgs(dryRun: boolean): ParsedArgs {
  return {
    rest: [],
    plugin: {},
    flags: new Set(dryRun ? ["--legacy", "--dry-run"] : ["--legacy"]),
    values: new Map([["target", "all"]]),
    valuesMulti: new Map(),
  };
}

function buildInstallArgs(dryRun: boolean): ParsedArgs {
  return {
    rest: [],
    plugin: {},
    flags: new Set(dryRun ? ["--force", "--dry-run"] : ["--force"]),
    values: new Map([["target", "all"]]),
    valuesMulti: new Map(),
  };
}

function buildNextSteps(dests: SelfInstallTargetResult[]): BootstrapNextStep[] {
  return [
    {
      harness: "claude-code",
      detected: dests.some((d) => d.target === "claude"),
      install_command: "/plugin marketplace add <marketplace-url>; /plugin install qtc",
      description:
        "En Claude Code: agregá el marketplace si aún no está, después instalá el plugin 'qtc'.",
    },
    {
      harness: "codex",
      detected: dests.some((d) => d.target === "codex"),
      install_command: "codex plugin install <marketplace-url>#qtc",
      description:
        "En Codex: instalá el plugin 'qtc' desde el marketplace y reiniciá la app para refrescar el cache.",
    },
  ];
}

function composeSummary(steps: BootstrapStep[], nextSteps: BootstrapNextStep[]): string {
  const ok = steps.filter((s) => s.status === "ok").length;
  const skipped = steps.filter((s) => s.status === "skipped").length;
  const detected = nextSteps.filter((n) => n.detected).map((n) => n.harness);
  const detectedFragment =
    detected.length > 0
      ? `Harnesses detectados: ${detected.join(", ")}.`
      : "Sin harnesses detectados — instalá Claude Code o Codex y volvé a correr.";
  return `Bootstrap completo: ${ok} pasos OK, ${skipped} saltados. ${detectedFragment} Ver next_steps[] para los comandos de instalación del plugin.`;
}

function failedResult(steps: BootstrapStep[], summary: string): CommandResult<SelfBootstrapData> {
  return {
    ok: true,
    data: {
      steps,
      next_steps: [],
      summary,
    },
    exitCode: 1,
  };
}
