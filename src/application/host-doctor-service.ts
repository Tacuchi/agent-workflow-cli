// Host-level doctor — checks external dependencies required by installed
// third-party plugins (e.g., `jq` for warp's hooks). Read-only, never mutates.
//
// Doctrine: this complements `plugin-doctor` (which audits agent-workflow
// plugins) by surfacing missing host deps that cause noisy hook errors during
// normal Claude Code use.
import { basename, dirname, join } from "node:path";
import type { EnvPort } from "../ports/env.js";
import type { DirEntry, FileSystemPort } from "../ports/file-system.js";
import type { ProcessPort } from "../ports/process.js";

export interface HostDoctorFinding {
  severity: "ok" | "warn";
  dependency: string;
  message: string;
  install_hint: { darwin: string; linux: string; win32: string };
  required_by: string[];
  plugin_paths: string[];
}

export interface HostDoctorOutput {
  status: "ok" | "warn";
  findings: HostDoctorFinding[];
}

/**
 * Plugins known to require external CLI dependencies. Add new entries as the
 * ecosystem grows. Matching is case-insensitive on the `name` field of the
 * plugin's `.claude-plugin/plugin.json` and on the marketplace directory name.
 */
const KNOWN_JQ_PLUGINS: readonly string[] = ["warp", "claude-code-warp"];

export async function runHostDoctor(
  fs: FileSystemPort,
  env: EnvPort,
  proc: ProcessPort,
): Promise<HostDoctorOutput> {
  const findings: HostDoctorFinding[] = [];

  const requiringJq = await detectPluginsRequiringJq(fs, env);
  if (requiringJq.length > 0) {
    const jqPath = await proc.which("jq");
    if (!jqPath) {
      findings.push({
        severity: "warn",
        dependency: "jq",
        message:
          "jq no encontrado en PATH. Los hooks de plugins detectados van a fallar (no bloqueante, pero ensucia la salida).",
        install_hint: {
          darwin: "brew install jq",
          linux: "apt install jq  # o equivalente del package manager",
          win32: "choco install jq  # o 'scoop install jq'",
        },
        required_by: dedupe(requiringJq.map((p) => p.name)),
        plugin_paths: requiringJq.map((p) => p.path),
      });
    } else {
      findings.push({
        severity: "ok",
        dependency: "jq",
        message: `jq disponible (${jqPath})`,
        install_hint: { darwin: "", linux: "", win32: "" },
        required_by: dedupe(requiringJq.map((p) => p.name)),
        plugin_paths: requiringJq.map((p) => p.path),
      });
    }
  }

  const status: "ok" | "warn" = findings.some((f) => f.severity === "warn") ? "warn" : "ok";
  return { status, findings };
}

interface DetectedPlugin {
  name: string;
  path: string;
}

async function detectPluginsRequiringJq(
  fs: FileSystemPort,
  env: EnvPort,
): Promise<DetectedPlugin[]> {
  const home = env.homeDir();
  const marketplacesRoot = join(home, ".claude", "plugins", "marketplaces");
  if (!(await fs.exists(marketplacesRoot))) return [];

  const detected: DetectedPlugin[] = [];
  const marketplaces = await safeList(fs, marketplacesRoot);
  for (const mp of marketplaces) {
    if (mp.type !== "dir") continue;
    const marketplaceName = basename(mp.path).toLowerCase();
    const pluginsDir = join(mp.path, "plugins");
    if (!(await fs.exists(pluginsDir))) continue;
    const plugins = await safeList(fs, pluginsDir);
    for (const plug of plugins) {
      if (plug.type !== "dir") continue;
      const pluginJson = join(plug.path, ".claude-plugin", "plugin.json");
      if (!(await fs.exists(pluginJson))) continue;
      const name = (await readPluginName(fs, pluginJson)) ?? basename(plug.path);
      if (matchesKnownList(name) || matchesKnownList(marketplaceName)) {
        detected.push({ name, path: dirname(dirname(pluginJson)) });
      }
    }
  }
  return detected;
}

function matchesKnownList(name: string): boolean {
  const lower = name.toLowerCase();
  return KNOWN_JQ_PLUGINS.some((known) => known === lower);
}

async function readPluginName(fs: FileSystemPort, pluginJson: string): Promise<string | null> {
  try {
    const text = await fs.readText(pluginJson);
    const parsed = JSON.parse(text) as { name?: unknown };
    return typeof parsed.name === "string" ? parsed.name : null;
  } catch {
    return null;
  }
}

async function safeList(fs: FileSystemPort, path: string): Promise<DirEntry[]> {
  try {
    return await fs.list(path);
  } catch {
    return [];
  }
}

function dedupe<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}
