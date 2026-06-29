import { createHash } from "node:crypto";
import { join } from "node:path";
import type { FileSystemPort } from "../ports/file-system.js";
import { detectStackDict } from "./stack-detect.js";

/** A launch parameter discovered from a source's config (env-vars). */
export interface LaunchParam {
  name: string;
  default: string;
  /** True when the name looks like a secret → masked in the TUI, never baked into versioned files. */
  secret: boolean;
}

/**
 * Machine-readable launch descriptor for one source (`.workflow/launch/<alias>/launch.json`).
 * The TUI reads this; it never parses the shell scripts.
 */
export interface LaunchDescriptor {
  version: 1;
  source: string;
  /** "npm" | "gradle" | "maven" | "angular" | "unknown". */
  stack: string;
  /** Working directory the command runs from (the source's absolute path). */
  cwd: string;
  /** Launch command, or null when no runnable command was detected (→ TUI disables "Lanzar"). */
  command: string | null;
  args: string[];
  params: LaunchParam[];
  /** Profiles discovered from config (`.env.<profile>`, `application-<profile>.yml`). */
  profiles: string[];
}

const SECRET_RE = /(SECRET|TOKEN|PASSWORD|PASSWD|PWD|API[_-]?KEY|PRIVATE|CREDENTIAL)/i;
const MARKER_RE = /^# agent-workflow:generated v\d+ sha256=([a-f0-9]+).*$/m;
const MARKER_LINE_RE = /^# agent-workflow:generated v\d+ sha256=[a-f0-9]+.*\r?\n/m;

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function isSecretName(name: string): boolean {
  return SECRET_RE.test(name);
}

/** Detect the launch descriptor for a source by inspecting its files. Pure (read-only). */
export async function detectLaunchDescriptor(
  fs: FileSystemPort,
  sourcePath: string,
  alias: string,
): Promise<LaunchDescriptor> {
  const detected = await detectStackDict(fs, sourcePath);
  const stack = stackKey(detected);
  const { command, args } = await deriveCommand(fs, sourcePath, stack);
  const { params, profiles } = await parseConfig(fs, sourcePath);
  return { version: 1, source: alias, stack, cwd: sourcePath, command, args, params, profiles };
}

function stackKey(detected: { build?: string; framework?: string }): string {
  const build = (detected.build ?? "").toLowerCase();
  if (build === "maven") return "maven";
  if (build === "gradle") return "gradle";
  if (detected.framework === "Angular") return "angular";
  if (build === "npm") return "npm";
  return "unknown";
}

async function deriveCommand(
  fs: FileSystemPort,
  sourcePath: string,
  stack: string,
): Promise<{ command: string | null; args: string[] }> {
  switch (stack) {
    case "npm": {
      const script = await pickNpmScript(fs, sourcePath);
      if (script === "start") return { command: "npm", args: ["start"] };
      if (script) return { command: "npm", args: ["run", script] };
      return { command: null, args: [] };
    }
    case "angular":
      return { command: "npm", args: ["start"] };
    case "gradle": {
      const wrapper = (await fs.exists(join(sourcePath, "gradlew"))) ? "./gradlew" : "gradle";
      return { command: wrapper, args: ["bootRun"] };
    }
    case "maven": {
      const wrapper = (await fs.exists(join(sourcePath, "mvnw"))) ? "./mvnw" : "mvn";
      return { command: wrapper, args: ["spring-boot:run"] };
    }
    default:
      return { command: null, args: [] };
  }
}

/** Prefer a `dev` script, then `start`; null when package.json has neither. */
async function pickNpmScript(fs: FileSystemPort, sourcePath: string): Promise<string | null> {
  try {
    const pkg = JSON.parse(await fs.readText(join(sourcePath, "package.json"))) as {
      scripts?: Record<string, string>;
    };
    const scripts = pkg.scripts ?? {};
    if (scripts.dev) return "dev";
    if (scripts.start) return "start";
    return null;
  } catch {
    return null;
  }
}

/** Parse `.env*` (and detect Spring `application-<profile>.*`) into params + profiles. */
async function parseConfig(
  fs: FileSystemPort,
  sourcePath: string,
): Promise<{ params: LaunchParam[]; profiles: string[] }> {
  let entries: { name: string }[] = [];
  try {
    entries = await fs.list(sourcePath);
  } catch {
    return { params: [], profiles: [] };
  }
  const names = entries.map((e) => e.name);
  const profiles = detectProfiles(names);

  // Params: union of keys across `.env` and `.env.<profile>` files; default from base `.env`.
  const params = new Map<string, LaunchParam>();
  const envFiles = names.filter((n) => n === ".env" || /^\.env\.[A-Za-z0-9_-]+$/.test(n));
  for (const file of envFiles) {
    let content: string;
    try {
      content = await fs.readText(join(sourcePath, file));
    } catch {
      continue;
    }
    mergeEnvParams(params, parseEnv(content), file === ".env");
  }

  return {
    params: [...params.values()].sort((a, b) => a.name.localeCompare(b.name)),
    profiles: profiles.sort(),
  };
}

/** Profiles from `.env.<profile>` (excluding `.env.local`) and `application-<profile>.{yml,yaml,properties}`. */
function detectProfiles(names: string[]): string[] {
  const profiles = new Set<string>();
  for (const name of names) {
    const envProfile = /^\.env\.([A-Za-z0-9_-]+)$/.exec(name)?.[1];
    if (envProfile && envProfile !== "local") profiles.add(envProfile);
    const springProfile = /^application-([A-Za-z0-9_-]+)\.(ya?ml|properties)$/.exec(name)?.[1];
    if (springProfile) profiles.add(springProfile);
  }
  return [...profiles];
}

/** Merge one env file's pairs into the param map; the base `.env` supplies defaults. */
function mergeEnvParams(
  params: Map<string, LaunchParam>,
  pairs: Array<[string, string]>,
  isBase: boolean,
): void {
  for (const [key, value] of pairs) {
    const existing = params.get(key);
    if (!existing) {
      params.set(key, { name: key, default: isBase ? value : "", secret: isSecretName(key) });
    } else if (isBase && existing.default === "") {
      existing.default = value;
    }
  }
}

function parseEnv(content: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    // Strip surrounding quotes; never carry a secret's value into the descriptor.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out.push([key, isSecretName(key) ? "" : value]);
  }
  return out;
}

// --- Rendering -------------------------------------------------------------

/**
 * Assemble a generated script with a self-describing hash marker. The recorded
 * hash covers the whole file EXCEPT the marker line itself (a line cannot hash
 * its own value), so regeneration can detect user edits to any other line.
 */
function withMarker(beforeMarker: string[], afterMarker: string[]): string {
  const hashed = `${[...beforeMarker, ...afterMarker].join("\n")}\n`;
  const marker = `# agent-workflow:generated v1 sha256=${sha256(hashed)}`;
  return `${[...beforeMarker, marker, ...afterMarker].join("\n")}\n`;
}

function humanHeader(desc: LaunchDescriptor): string[] {
  return [
    `# Lanzamiento directo de ${desc.source} (${desc.stack}).`,
    "# Editá libremente debajo: agent-workflow NO re-genera scripts que hayas editado.",
  ];
}

export function renderLaunchJson(desc: LaunchDescriptor): string {
  const hash = sha256(JSON.stringify(desc, null, 2));
  const withMeta = { ...desc, _generated: { version: 1, sha256: hash } };
  return `${JSON.stringify(withMeta, null, 2)}\n`;
}

export function renderRunSh(desc: LaunchDescriptor): string {
  const after: string[] = [
    ...humanHeader(desc),
    "set -euo pipefail",
    `cd "${desc.cwd}"`,
    'PROFILE="${1:-}"',
    'if [ -n "$PROFILE" ] && [ -f ".env.$PROFILE" ]; then set -a; . "./.env.$PROFILE"; set +a; fi',
  ];
  for (const p of desc.params) {
    after.push(`export ${p.name}="\${${p.name}:-${shEscape(p.default)}}"`);
  }
  if (desc.command) {
    after.push(`exec ${desc.command} ${desc.args.map(shQuote).join(" ")}`.trimEnd());
  } else {
    after.push(
      `echo "No se detectó comando de arranque para ${desc.source}. Completá este script." >&2`,
    );
    after.push("exit 1");
  }
  return withMarker(["#!/usr/bin/env bash"], after);
}

export function renderRunPs1(desc: LaunchDescriptor): string {
  const after: string[] = [
    ...humanHeader(desc),
    'param([string]$Profile = "")',
    "$ErrorActionPreference = 'Stop'",
    `Set-Location "${desc.cwd}"`,
    'if ($Profile -and (Test-Path ".env.$Profile")) { Get-Content ".env.$Profile" | ForEach-Object { if ($_ -match "^\\s*([^#=]+)=(.*)$") { [Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2].Trim()) } } }',
  ];
  for (const p of desc.params) {
    after.push(`if (-not $env:${p.name}) { $env:${p.name} = "${ps1Escape(p.default)}" }`);
  }
  if (desc.command) {
    after.push(`& ${ps1Quote(desc.command)} ${desc.args.map(ps1Quote).join(" ")}`.trimEnd());
  } else {
    after.push(
      `Write-Error "No se detectó comando de arranque para ${desc.source}. Completá este script."`,
    );
    after.push("exit 1");
  }
  return withMarker([], after);
}

function shEscape(v: string): string {
  return v.replace(/(["\\$`])/g, "\\$1");
}
function shQuote(v: string): string {
  return /^[A-Za-z0-9_./:-]+$/.test(v) ? v : `'${v.replace(/'/g, "'\\''")}'`;
}
function ps1Escape(v: string): string {
  return v.replace(/`/g, "``").replace(/"/g, '`"');
}
function ps1Quote(v: string): string {
  return /^[A-Za-z0-9_./:-]+$/.test(v) ? v : `"${ps1Escape(v)}"`;
}

// --- Idempotent writes -----------------------------------------------------

export type WriteOutcome = "created" | "regenerated" | "preserved";

/**
 * Write `content` to `path` only if the on-disk file is still pristine (its
 * recorded hash matches its current body). A user-edited file is preserved.
 * `extractRecorded` returns the recorded hash + the hash of the current body,
 * or null when the file has no marker (treated as user-owned → preserved).
 */
async function writeIfPristine(
  fs: FileSystemPort,
  path: string,
  content: string,
  recompute: (existing: string) => { recorded: string; actual: string } | null,
): Promise<WriteOutcome> {
  if (!(await fs.exists(path))) {
    await fs.writeText(path, content);
    return "created";
  }
  const existing = await fs.readText(path);
  const check = recompute(existing);
  if (check && check.recorded === check.actual) {
    await fs.writeText(path, content);
    return "regenerated";
  }
  return "preserved";
}

function shellRecompute(existing: string): { recorded: string; actual: string } | null {
  const m = MARKER_RE.exec(existing);
  if (!m) return null;
  const recorded = m[1] as string;
  // Hash covers the whole file minus the marker line (symmetric with withMarker).
  const withoutMarker = existing.replace(MARKER_LINE_RE, "");
  return { recorded, actual: sha256(withoutMarker) };
}

function jsonRecompute(existing: string): { recorded: string; actual: string } | null {
  try {
    const parsed = JSON.parse(existing) as Record<string, unknown> & {
      _generated?: { sha256?: string };
    };
    const recorded = parsed._generated?.sha256;
    if (typeof recorded !== "string") return null;
    const { _generated, ...rest } = parsed;
    return { recorded, actual: sha256(JSON.stringify(rest, null, 2)) };
  } catch {
    return null;
  }
}

export interface SourceArtifactResult {
  alias: string;
  stack: string;
  launchable: boolean;
  outcomes: { launchJson: WriteOutcome; runSh: WriteOutcome; runPs1: WriteOutcome };
}

/** Generate (idempotently) the descriptor + per-OS scripts for one source. */
export async function generateSourceLaunchArtifacts(
  fs: FileSystemPort,
  launchDir: string,
  sourcePath: string,
  alias: string,
): Promise<SourceArtifactResult> {
  const desc = await detectLaunchDescriptor(fs, sourcePath, alias);
  const dir = join(launchDir, alias);
  await fs.mkdirp(dir);
  const launchJson = await writeIfPristine(
    fs,
    join(dir, "launch.json"),
    renderLaunchJson(desc),
    jsonRecompute,
  );
  const runSh = await writeIfPristine(fs, join(dir, "run.sh"), renderRunSh(desc), shellRecompute);
  const runPs1 = await writeIfPristine(
    fs,
    join(dir, "run.ps1"),
    renderRunPs1(desc),
    shellRecompute,
  );
  return {
    alias,
    stack: desc.stack,
    launchable: desc.command !== null,
    outcomes: { launchJson, runSh, runPs1 },
  };
}

export interface LaunchArtifactsSummary {
  generated: SourceArtifactResult[];
  skipped: { alias: string; reason: "path_not_found" }[];
}

/**
 * Generate launch artifacts for every source under `launchDir/<alias>/`. Always
 * generates (no capability gate); a source whose path is missing is skipped
 * rather than producing junk.
 */
export async function generateLaunchArtifacts(
  fs: FileSystemPort,
  launchDir: string,
  sources: { alias: string; path: string }[],
): Promise<LaunchArtifactsSummary> {
  const generated: SourceArtifactResult[] = [];
  const skipped: LaunchArtifactsSummary["skipped"] = [];
  for (const s of sources) {
    if (!(await fs.exists(s.path))) {
      skipped.push({ alias: s.alias, reason: "path_not_found" });
      continue;
    }
    generated.push(await generateSourceLaunchArtifacts(fs, launchDir, s.path, s.alias));
  }
  return { generated, skipped };
}
