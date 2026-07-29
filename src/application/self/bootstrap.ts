import type { ParsedArgs } from "../../cli/parser.js";
import type { CliContext } from "../../cli/types.js";
import { HARNESSES, type HarnessId, type InstallTarget } from "../../domain/harnesses.js";
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
  harness: HarnessId;
  target: InstallTarget;
  label: string;
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
  const baseFlags = dryRun ? ["--force", "--dry-run"] : ["--force", "--confirm-all"];
  return {
    rest: [],
    plugin: {},
    flags: new Set(baseFlags),
    values: new Map([["target", "all"]]),
    valuesMulti: new Map(),
  };
}

// Per-host wording for the plugin-marketplace channel. The SET of hosts is
// derived from the catalog (`pluginManifest !== null`), so a new plugin-capable
// host shows up here on its own; only the phrasing is authored, and a host
// without one still gets an honest generic line instead of being dropped.
const PLUGIN_INSTALL_HINTS: Partial<Record<HarnessId, { command: string; description: string }>> = {
  "claude-code": {
    command: "/plugin marketplace add <marketplace-url>; /plugin install <plugin-name>",
    description:
      "En Claude Code: agregá el marketplace si aún no está, después instalá el plugin requerido.",
  },
  codex: {
    command: "codex plugin install <marketplace-url>#<plugin-name>",
    description:
      "En Codex: instalá el plugin desde el marketplace y reiniciá la app para refrescar el cache.",
  },
};

function buildNextSteps(dests: SelfInstallTargetResult[]): BootstrapNextStep[] {
  return HARNESSES.filter((h) => h.pluginManifest !== null).map((h) => {
    const hint = PLUGIN_INSTALL_HINTS[h.id];
    return {
      harness: h.id,
      target: h.installTarget,
      label: h.label,
      detected: dests.some((d) => d.target === h.installTarget),
      install_command: hint?.command ?? `(consultá la documentación de ${h.label})`,
      description:
        hint?.description ??
        `${h.label} soporta plugins (${h.pluginManifest}); instalá el plugin desde su marketplace.`,
    };
  });
}

function composeSummary(steps: BootstrapStep[], nextSteps: BootstrapNextStep[]): string {
  const ok = steps.filter((s) => s.status === "ok").length;
  const skipped = steps.filter((s) => s.status === "skipped").length;
  const detected = nextSteps.filter((n) => n.detected).map((n) => n.label);
  const candidates = nextSteps.map((n) => n.label).join(" o ");
  const detectedFragment =
    detected.length > 0
      ? `Harnesses detectados: ${detected.join(", ")}.`
      : `Sin harnesses con plugin detectados — instalá ${candidates} y volvé a correr.`;
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
