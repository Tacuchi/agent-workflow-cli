// Observable host states — the single place that answers "what is really true
// about this host on this machine".
//
// Detection used to be one boolean (`~/.<host>` exists?) doing four jobs at
// once, so a leftover config dir read as a live host and a host that exports no
// env marker read as absent. The four states are now separate and each one
// carries its evidence:
//
//   1. config present   — the host's config dir exists on disk
//   2. runtime available — its binary can actually be invoked (NOT env markers:
//                          several hosts export none to their subprocesses)
//   3. Workline installed — our bundle is in that host's skills root
//   4. capabilities      — which Workline mechanisms this host can really use
//
// Shared destinations (`~/.agents/skills`) are reported apart: they have no
// runtime and must never inflate a host count (spec 010, criterion 3).

import { dirname, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { CliContext } from "../../cli/types.js";
import {
  HARNESSES,
  type HarnessId,
  type HarnessSpec,
  type InstallTarget,
  SHARED_SKILL_DESTINATIONS,
  type SupportTier,
  hookCoverage,
  hookMechanism,
  verificationFor,
} from "../../domain/harnesses.js";
import type { HarnessVerification } from "../../domain/host-verification.js";
import { crushGlobalMcpFile, opencodeGlobalMcpFile } from "../mcp-host-paths.js";
import { resolveWarpGlobalMcpPath } from "../multiroot/warp.js";
import {
  countOurAgyHooks,
  countOurCrushHooks,
  hooksTemplateToAgy,
  hooksTemplateToCrush,
} from "./hooks-json.js";
import { countOurHookEntries, hooksTemplateToToml } from "./hooks-toml.js";
import { type HooksTemplate, resolveBundledHookTemplate } from "./install-hooks.js";
import { SKILL_DIR_NAME, USER_COMMANDS_BY_TARGET } from "./install-skill.js";
import { COMMAND_SKILLS_HOSTS, TARGET_ROOTS } from "./install-targets.js";
import { type McpViaState, readMcpViaState } from "./mcp-via-state.js";
import { buildOpencodePlugin } from "./opencode-plugin.js";

/** Upper bound for a single `--version` call. Probes run in parallel across hosts. */
const RUNTIME_PROBE_TIMEOUT_MS = 2500;

export type RuntimeState =
  /** The binary was found and answered. */
  | "available"
  /** The host declares a CLI and none of its binaries are reachable. */
  | "missing"
  /** The host ships no CLI at all (Warp is a GUI app) — nothing to probe. */
  | "not-probeable";

export interface RuntimeProbe {
  state: RuntimeState;
  /** Resolved binary path, when one was found. */
  bin: string | null;
  /** Version read from the binary, when it could be read. */
  version: string | null;
  /** Why this state — how the binary was found, or why it wasn't. */
  evidence: string;
}

export type CapabilityStatus =
  /** Works through the host's own mechanism. */
  | "native"
  /** Works through a fallback that preserves the result but not the shape. */
  | "degraded"
  /** The host cannot do this at all. */
  | "unsupported";

export interface HostCapability {
  id: "skills" | "commands" | "structured-choice" | "subagent-dispatch" | "hooks" | "mcp";
  status: CapabilityStatus;
  /** How it works here — the fallback when degraded, the reason when unsupported. */
  detail: string;
}

export type HostStatus =
  /** Runtime available (or, for a CLI-less host, config present) AND Workline installed. */
  | "ready"
  /** The host is here; Workline is not installed on it yet. */
  | "installable"
  /** Config dir left behind with no runtime to use it. */
  | "residual-config"
  /** No trace of this host on this machine. */
  | "absent";

export interface HostStateReport {
  host: HarnessId;
  target: InstallTarget;
  label: string;
  tier: SupportTier;
  unstable_surface: boolean;
  /** What a verification run proved, or null when none ever covered this host. */
  verified: HarnessVerification | null;
  config: { present: boolean; path: string | null; reason?: string };
  runtime: RuntimeProbe;
  workline: { installed: boolean; path: string };
  capabilities: HostCapability[];
  /**
   * La vía MCP en este host, con sus tres preguntas por separado.
   *
   * Aparte de `capabilities` porque ahí cada capacidad tiene UN estado, y acá lo
   * que la persona necesita saber es cuál de las tres arreglar.
   */
  mcp_via: McpViaState;
  status: HostStatus;
  /** Proportional next action, or null when nothing is pending. */
  advice: string | null;
}

export interface SharedDestinationReport {
  target: InstallTarget;
  label: string;
  path: string;
  installed: boolean;
  /** Labels of the hosts that read this dir — why installing here is useful. */
  read_by: string[];
  /** Stated on every surface so it is never mistaken for a host. */
  note: string;
}

function expandHome(path: string, home: string): string {
  return path.startsWith("~") ? join(home, path.slice(1)) : path;
}

/**
 * Global config dir for a host, or null when it keeps none of its own.
 * Platform-divergent hosts derive it from their global MCP path — the same
 * registry the MCP writer and reader use, never a second source.
 */
export function resolveHostConfigDir(
  spec: HarnessSpec,
  home: string,
): { path: string | null; reason?: string } {
  if (spec.configDir.kind === "dir") return { path: expandHome(spec.configDir.path, home) };
  if (spec.configDir.kind === "none") return { path: null, reason: spec.configDir.reason };
  if (spec.id === "opencode") return { path: dirname(opencodeGlobalMcpFile(home)) };
  if (spec.id === "crush") return { path: dirname(crushGlobalMcpFile(home)) };
  if (spec.id === "warp") {
    const mcpFile = resolveWarpGlobalMcpPath(process.platform, () => home);
    return mcpFile
      ? { path: dirname(mcpFile) }
      : { path: null, reason: "no global MCP path on this platform" };
  }
  return { path: null, reason: "no config dir resolver for this host" };
}

/** First `<major>.<minor>…` token in the output — covers every host's `--version` shape. */
export function extractVersion(output: string): string | null {
  return /\d+\.\d+[\w.\-+]*/.exec(output)?.[0] ?? null;
}

/**
 * Is the runtime actually invocable? Looks for the binary (PATH first, then the
 * locations the catalog declares — Kimi installs to `~/.kimi-code/bin`, which
 * only interactive shells add) and reads its version.
 */
export async function probeRuntime(spec: HarnessSpec, ctx: CliContext): Promise<RuntimeProbe> {
  const { bins, fallbackBinPaths = [], versionArgs } = spec.runtime;
  if (bins.length === 0) {
    return {
      state: "not-probeable",
      bin: null,
      version: null,
      evidence: `${spec.label} ships no CLI of its own — presence is judged by its config dir.`,
    };
  }

  const home = ctx.env.homeDir();
  let found: { bin: string; how: string } | null = null;
  for (const bin of bins) {
    const resolved = await ctx.process.which(bin);
    if (resolved !== undefined) {
      found = { bin: resolved, how: `'${bin}' on PATH` };
      break;
    }
  }
  if (found === null) {
    for (const candidate of fallbackBinPaths) {
      const abs = expandHome(candidate, home);
      if (await ctx.fs.exists(abs)) {
        found = { bin: abs, how: `declared path ${candidate} (not on PATH)` };
        break;
      }
    }
  }
  if (found === null) {
    const where = [`PATH (${bins.join(", ")})`, ...fallbackBinPaths].join(" · ");
    return { state: "missing", bin: null, version: null, evidence: `not found in ${where}` };
  }

  try {
    const res = await ctx.process.run(found.bin, [...versionArgs], {
      timeoutMs: RUNTIME_PROBE_TIMEOUT_MS,
    });
    const version = extractVersion(`${res.stdout}\n${res.stderr}`);
    return {
      state: "available",
      bin: found.bin,
      version,
      evidence:
        version === null
          ? `${found.how}; ran ${versionArgs.join(" ")} but no version in its output`
          : `${found.how}; reported ${version}`,
    };
  } catch (err) {
    // The binary IS there — a failed version call does not make the host absent.
    return {
      state: "available",
      bin: found.bin,
      version: null,
      evidence: `${found.how}; version probe failed: ${(err as Error).message}`,
    };
  }
}

/**
 * Which Workline mechanisms this host can really use. Every row is DERIVED from
 * the catalog and the installer's own maps, so no surface can announce a
 * capability the installer does not implement (spec 010, criterion 6).
 */
export function capabilitiesFor(spec: HarnessSpec): HostCapability[] {
  const commands = USER_COMMANDS_BY_TARGET[spec.installTarget];
  return [
    {
      id: "skills",
      status: "native",
      detail: `auto-discovered from ${spec.skillsDirs.join(", ")}`,
    },
    commands !== null
      ? { id: "commands", status: "native", detail: `~/${commands.relpath} (${commands.format})` }
      : COMMAND_SKILLS_HOSTS.has(spec.installTarget)
        ? {
            id: "commands",
            status: "degraded",
            detail:
              "no commands dir: each command ships as a top-level 'w-<command>' skill next to the bundle",
          }
        : {
            id: "commands",
            status: "unsupported",
            detail: "no commands dir and no skill-as-command wrappers installed for this host",
          },
    // structured-choice is one of the two capabilities a loop cannot do without, and
    // until now it lived only in doctrine: no surface could say what a host really
    // does with a human boundary. Projected from the same catalog entry the
    // installer stamps, so the state and the installed wrapper cannot disagree.
    {
      id: "structured-choice",
      status: spec.structuredChoice.state,
      detail: structuredChoiceDetail(spec),
    },
    spec.execution.subagents === "parallel"
      ? {
          id: "subagent-dispatch",
          status: "native",
          detail: `${spec.execution.mechanism ?? "host workers"}; the CLI permits at most ${spec.execution.max_subagents} after proving independent semantic partitions`,
        }
      : {
          id: "subagent-dispatch",
          status: "unsupported",
          detail:
            "no native worker dispatch; deterministic steps stay in the CLI and semantic work stays inline",
        },
    spec.hooks === null
      ? { id: "hooks", status: "unsupported", detail: "this host has no hook system" }
      : spec.hooks.managed
        ? {
            id: "hooks",
            status: "native",
            // The coverage rides along even here: claude carries all five, kimi
            // carries PostCompact with a handler missing, and "installed" alone
            // would read as parity between the two.
            detail: `installed into ${hookMechanism(spec.hooks)} — ${hookCoverage(spec.hooks)}`,
          }
        : {
            id: "hooks",
            status: "degraded",
            detail: `host supports hooks (${hookMechanism(spec.hooks)}) — ${hookCoverage(spec.hooks)}; ${notManagedHere(spec)}`,
          },
    spec.mcpHostId === null
      ? {
          id: "mcp",
          status: "degraded",
          detail: "no MCP config file: this host takes servers through a launch flag",
        }
      : { id: "mcp", status: "native", detail: `written to its ${spec.mcpHostId} MCP config` },
  ];
}

/**
 * Why Workline does not arm this host's hooks, and what it does instead.
 *
 * Codex is the one host with a second route: a plugin bundle whose hooks skip its
 * per-hook trust review. The bundle is generated, never installed — codex takes
 * plugins through a marketplace — so the state says "generated, not armed" and
 * stops there. Every other unmanaged host gets the plain answer.
 */
function notManagedHere(spec: HarnessSpec): string {
  if (spec.id === "codex") {
    return "Workline generates its plugin bundle instead ('aw self install-hooks --target codex'), which is NOT armed: installing a codex plugin goes through a marketplace and is yours to run";
  }
  if (spec.id === "opencode") {
    return "Workline generates its plugin module instead ('aw self install-hooks --target opencode'), declared in opencode.json: the tool guards travel, the session and compaction hooks do not";
  }
  return "Workline does not install them here — the CLI commands stay callable";
}

/**
 * One line for what a human boundary really does here.
 *
 * Every branch names the fallback condition, because "native" without it reads as
 * "always native" — and on three of the four native hosts it is not.
 */
function structuredChoiceDetail(spec: HarnessSpec): string {
  const binding = spec.structuredChoice;
  const ceiling =
    binding.ceilings === null
      ? "no per-call ceiling declared"
      : `${binding.ceilings.questions}×${binding.ceilings.options} per call`;
  if (binding.state === "native" && binding.tool !== null) {
    return `${binding.tool} (${ceiling}); labeled markdown when ${binding.fallbackReason}`;
  }
  if (binding.tool !== null) {
    return `${binding.tool} exists but is not always offered (${binding.fallbackReason}) → use it when the turn lists it, else labeled markdown`;
  }
  return `no native selection surface (${binding.fallbackReason}) → labeled markdown`;
}

function deriveStatus(present: boolean, runtime: RuntimeProbe, installed: boolean): HostStatus {
  // A CLI-less host cannot be probed, so its config dir IS the presence signal.
  const here = runtime.state === "available" || (runtime.state === "not-probeable" && present);
  if (here) return installed ? "ready" : "installable";
  return present ? "residual-config" : "absent";
}

function deriveAdvice(
  status: HostStatus,
  spec: HarnessSpec,
  configPath: string | null,
): string | null {
  if (status === "installable") {
    return `Run 'agent-workflow self install-skill --target ${spec.installTarget}' to install the bundle.`;
  }
  if (status === "residual-config") {
    return `Config dir ${configPath ?? "(unknown)"} exists but no ${spec.label} runtime answers. Reinstall the host, or run 'agent-workflow self uninstall --target ${spec.installTarget}' to clear what Workline left there.`;
  }
  return null;
}

/** Full state report for one host. */
export async function reportHostState(
  spec: HarnessSpec,
  ctx: CliContext,
): Promise<HostStateReport> {
  const home = ctx.env.homeDir();
  const config = resolveHostConfigDir(spec, home);
  const worklinePath = join(home, ...TARGET_ROOTS[spec.installTarget], SKILL_DIR_NAME);
  const [configPresent, installed, runtime] = await Promise.all([
    config.path === null ? Promise.resolve(false) : ctx.fs.exists(config.path),
    ctx.fs.exists(worklinePath),
    probeRuntime(spec, ctx),
  ]);
  const status = deriveStatus(configPresent, runtime, installed);

  return {
    mcp_via: readMcpViaState(spec, home),
    host: spec.id,
    target: spec.installTarget,
    label: spec.label,
    tier: spec.support.tier,
    unstable_surface: spec.support.unstableSurface === true,
    verified: verificationFor(spec.id),
    config: {
      present: configPresent,
      path: config.path,
      ...(config.reason ? { reason: config.reason } : {}),
    },
    runtime,
    workline: { installed, path: worklinePath },
    capabilities: capabilitiesFor(spec),
    status,
    advice: deriveAdvice(status, spec, config.path),
  };
}

/** State report for every host in the catalog. Probes run in parallel. */
export async function reportAllHostStates(ctx: CliContext): Promise<HostStateReport[]> {
  return Promise.all(HARNESSES.map((spec) => reportHostState(spec, ctx)));
}

// ─── hooks armed, per host ───────────────────────────────────────────────────

export interface HooksArmedReport {
  target: InstallTarget;
  label: string;
  /** Our hook entries are present in this host's config. */
  armed: boolean;
  /** The file that was inspected. */
  path: string;
}

/**
 * What a host cannot carry from the bundled template — a DIFFERENT question from
 * "are our hooks armed", and reported apart for that reason.
 *
 * `armed: true` alone overstates the case on a host that expresses only part of the
 * set: it says "the hooks are there" while one of them silently is not. So the same
 * declared losses the install output reports are readable from the state too, out
 * of the same transform — two wordings would eventually disagree.
 *
 * Kept out of {@link HooksArmedReport} because answering it costs a template read,
 * and the surfaces that only need the armed count should not pay for it.
 */
export interface HookTemplateLossReport {
  target: InstallTarget;
  /** One line per loss. Empty is a real answer: this host carries everything. */
  losses: string[];
  /** False when the template could not be read, so `losses` is unknown, not empty. */
  template_read: boolean;
}

/**
 * Per-host "are OUR hooks in place" probes. Only hosts whose hooks Workline
 * MANAGES appear here — `hooksArmedProbeCoverage()` proves the two sets match,
 * so a host can never be declared managed while nothing can tell whether its
 * hooks are actually armed.
 */
const HOOKS_ARMED_PROBES: Partial<
  Record<
    InstallTarget,
    (ctx: CliContext, home: string) => Promise<{ armed: boolean; path: string }>
  >
> = {
  claude: async (ctx, home) => {
    const path = join(home, ".claude", "settings.json");
    return { armed: await claudeHooksArmed(ctx, path), path };
  },
  crush: async (ctx, home) => {
    const path = crushGlobalMcpFile(home);
    return { armed: (await countJsonHooks(ctx, path, countOurCrushHooks)) > 0, path };
  },
  gemini: async (ctx, home) => {
    const path = join(home, ".agents", "hooks.json");
    return { armed: (await countJsonHooks(ctx, path, countOurAgyHooks)) > 0, path };
  },
  kimi: async (ctx, home) => {
    // Read through a real TOML parse, NOT by looking for our comment markers:
    // Kimi rewrites this file on its own and drops every comment while keeping
    // the hooks. Marker-based detection reported "off" while our hooks were live.
    const path = join(home, ".kimi-code", "config.toml");
    if (!(await ctx.fs.exists(path))) return { armed: false, path };
    try {
      const ours = countOurHookEntries(await ctx.fs.readText(path), parseToml);
      return { armed: (ours ?? 0) > 0, path };
    } catch {
      return { armed: false, path };
    }
  },
};

/**
 * Our entries in a JSON host config, read through a real parse.
 *
 * Zero on an absent or unreadable file: "we cannot tell" and "they are not
 * armed" look the same to a probe, and claiming armed on a file nobody could
 * read is the one answer that would be a lie.
 */
async function countJsonHooks(
  ctx: CliContext,
  path: string,
  count: (doc: Record<string, unknown>) => number,
): Promise<number> {
  if (!(await ctx.fs.exists(path))) return 0;
  try {
    const parsed = JSON.parse(await ctx.fs.readText(path));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? count(parsed as Record<string, unknown>)
      : 0;
  } catch {
    return 0;
  }
}

/**
 * A non-empty `hooks{}` is NOT enough: the user may keep hooks of their own.
 * Ours are the entries whose command invokes this CLI.
 */
async function claudeHooksArmed(ctx: CliContext, path: string): Promise<boolean> {
  if (!(await ctx.fs.exists(path))) return false;
  try {
    const parsed = JSON.parse(await ctx.fs.readText(path)) as { hooks?: Record<string, unknown> };
    if (!parsed.hooks || Object.keys(parsed.hooks).length === 0) return false;
    return JSON.stringify(parsed.hooks).includes("agent-workflow");
  } catch {
    return false;
  }
}

/** Targets whose hooks Workline manages but that have no armed-probe. Must be empty. */
export function hooksArmedProbeCoverage(): InstallTarget[] {
  return HARNESSES.filter((h) => h.hooks?.managed === true)
    .map((h) => h.installTarget)
    .filter((t) => HOOKS_ARMED_PROBES[t] === undefined);
}

/**
 * What each managed host loses when the bundled template is adapted to it.
 *
 * Per-host and keyed like `HOOKS_ARMED_PROBES`, for the same reason: a host name
 * spelled straight into a function body is exactly how the four registries in this
 * codebase once drifted apart. A host absent from this map declares nothing to
 * lose, which is the truth for a host that merges the template whole (Claude) and
 * would be a lie waiting to happen for one that transforms it.
 */
const HOOK_TEMPLATE_LOSSES: Partial<Record<InstallTarget, (template: HooksTemplate) => string[]>> =
  {
    kimi: (template) => {
      const { skipped, degraded } = hooksTemplateToToml(template);
      return [
        ...skipped.map((s) => `${s.event}: skipped — ${s.reason}`),
        ...degraded.map((d) => `${d.event}: ${d.reason}`),
      ];
    },
    crush: (template) => skipLines(hooksTemplateToCrush(template).skipped),
    gemini: (template) => skipLines(hooksTemplateToAgy(template).skipped),
    opencode: (template) => skipLines(buildOpencodePlugin(template).skipped),
  };

/** The four events neither JSON dialect carries, one line each. */
function skipLines(skipped: readonly { event: string; reason: string }[]): string[] {
  return skipped.map((s) => `${s.event}: skipped — ${s.reason}`);
}

/**
 * What each managed host cannot carry from the bundled template.
 *
 * Read once per report rather than per host: the template is one file and every
 * adapter is pure, so a second read would only add a way for two hosts in the same
 * report to disagree about what the template says.
 */
async function templateLosses(
  ctx: CliContext,
): Promise<{ read: boolean; byTarget: Map<InstallTarget, string[]> }> {
  const byTarget = new Map<InstallTarget, string[]>();
  const path = await resolveBundledHookTemplate();
  if (path === null || !(await ctx.fs.exists(path))) return { read: false, byTarget };
  let template: HooksTemplate;
  try {
    template = JSON.parse(await ctx.fs.readText(path));
  } catch {
    return { read: false, byTarget };
  }
  for (const [target, losses] of Object.entries(HOOK_TEMPLATE_LOSSES)) {
    byTarget.set(target as InstallTarget, losses(template));
  }
  return { read: true, byTarget };
}

/** Hook state for every host whose hooks Workline manages. */
export async function reportHooksArmed(ctx: CliContext): Promise<HooksArmedReport[]> {
  const home = ctx.env.homeDir();
  const managed = HARNESSES.filter((h) => h.hooks?.managed === true);
  return Promise.all(
    managed.map(async (spec) => {
      const probe = HOOKS_ARMED_PROBES[spec.installTarget];
      if (probe === undefined) {
        // Guarded by hooksArmedProbeCoverage(); reported, never guessed.
        return { target: spec.installTarget, label: spec.label, armed: false, path: "(no probe)" };
      }
      const { armed, path } = await probe(ctx, home);
      return { target: spec.installTarget, label: spec.label, armed, path };
    }),
  );
}

/**
 * What each managed host loses when the template is adapted to it.
 *
 * Its own entry point, called by the surfaces that DISPLAY the losses. Folding it
 * into `reportHooksArmed` made every status refresh resolve and read the bundled
 * template for a number it does not show — and the status tab's own test caught it.
 */
export async function reportHookTemplateLosses(ctx: CliContext): Promise<HookTemplateLossReport[]> {
  const { read, byTarget } = await templateLosses(ctx);
  return HARNESSES.filter((h) => h.hooks?.managed === true).map((spec) => ({
    target: spec.installTarget,
    losses: byTarget.get(spec.installTarget) ?? [],
    template_read: read,
  }));
}

/** Shared skills dirs — install destinations, never hosts. */
export async function reportSharedDestinations(
  ctx: CliContext,
): Promise<SharedDestinationReport[]> {
  const home = ctx.env.homeDir();
  return Promise.all(
    SHARED_SKILL_DESTINATIONS.map(async (dest) => {
      const path = join(home, ...TARGET_ROOTS[dest.id], SKILL_DIR_NAME);
      return {
        target: dest.id,
        label: dest.label,
        path,
        installed: await ctx.fs.exists(path),
        read_by: dest.readBy.map((id) => HARNESSES.find((h) => h.id === id)?.label ?? id),
        note: "Shared skills dir, not a host: it has no runtime and never counts as one.",
      };
    }),
  );
}
