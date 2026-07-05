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

/** A command + args pair — a build/prep step or the run step. */
export interface LaunchStep {
  command: string;
  args: string[];
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
  /**
   * Optional build/compile step run before `command` (e.g. `npm run build` for a
   * CLI/app that runs from its compiled output). null when the run needs none.
   */
  build: LaunchStep | null;
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
  const { build, command, args } = await deriveCommand(fs, sourcePath, stack);
  const { params, profiles } = await parseConfig(fs, sourcePath);
  return {
    version: 1,
    source: alias,
    stack,
    cwd: sourcePath,
    build,
    command,
    args,
    params,
    profiles,
  };
}

/** The build + run steps for a source; command=null when nothing runnable was found. */
interface DerivedLaunch {
  build: LaunchStep | null;
  command: string | null;
  args: string[];
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
): Promise<DerivedLaunch> {
  switch (stack) {
    case "npm":
      return deriveNpm(fs, sourcePath);
    case "angular":
      return { build: null, command: "npm", args: ["start"] };
    case "gradle": {
      const wrapper = (await fs.exists(join(sourcePath, "gradlew"))) ? "./gradlew" : "gradle";
      return { build: null, command: wrapper, args: ["bootRun"] };
    }
    case "maven": {
      const wrapper = (await fs.exists(join(sourcePath, "mvnw"))) ? "./mvnw" : "mvn";
      return { build: null, command: wrapper, args: ["spring-boot:run"] };
    }
    default:
      return { build: null, command: null, args: [] };
  }
}

interface NpmPackage {
  scripts?: Record<string, string>;
  bin?: string | Record<string, string>;
  main?: string;
}

/**
 * Derive how to run an npm project locally, in priority order:
 *  1. a run script — `dev` > `start` > `serve` (self-contained; no build needed).
 *  2. else a CLI/app entry — `bin` > `main` — run via `node`, building first when
 *     a `build` script exists (a TypeScript CLI runs from its compiled output).
 * command=null only when there is genuinely nothing to run (no script, no entry).
 */
async function deriveNpm(fs: FileSystemPort, sourcePath: string): Promise<DerivedLaunch> {
  const pkg = await readPackageJson(fs, sourcePath);
  if (!pkg) return { build: null, command: null, args: [] };
  const scripts = pkg.scripts ?? {};
  if (scripts.dev) return { build: null, command: "npm", args: ["run", "dev"] };
  if (scripts.start) return { build: null, command: "npm", args: ["start"] };
  if (scripts.serve) return { build: null, command: "npm", args: ["run", "serve"] };
  const entry = binEntry(pkg) ?? (typeof pkg.main === "string" ? pkg.main : null);
  if (entry) {
    const build: LaunchStep | null = scripts.build
      ? { command: "npm", args: ["run", "build"] }
      : null;
    return { build, command: "node", args: [entry] };
  }
  return { build: null, command: null, args: [] };
}

async function readPackageJson(fs: FileSystemPort, sourcePath: string): Promise<NpmPackage | null> {
  try {
    return JSON.parse(await fs.readText(join(sourcePath, "package.json"))) as NpmPackage;
  } catch {
    return null;
  }
}

/** First bin target: a string bin IS the entry; an object bin uses its first path. */
function binEntry(pkg: NpmPackage): string | null {
  const bin = pkg.bin;
  if (typeof bin === "string" && bin.length > 0) return bin;
  if (bin && typeof bin === "object") {
    return Object.values(bin).find((v) => typeof v === "string" && v.length > 0) ?? null;
  }
  return null;
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
    if (desc.build) {
      // Build before running; `set -e` (above) aborts on a failed build.
      after.push(`${desc.build.command} ${desc.build.args.map(shQuote).join(" ")}`.trimEnd());
    }
    after.push(`exec ${desc.command} ${desc.args.map(shQuote).join(" ")}`.trimEnd());
  } else {
    after.push(
      `echo "No se detectó comando de arranque para ${desc.source}. Completá este script." >&2`,
    );
    after.push("exit 1");
  }
  return withMarker(["#!/usr/bin/env bash"], after);
}

/**
 * Windows form of a launch command: the JVM wrappers are bash scripts without
 * extension; PowerShell/cmd need their `.bat`/`.cmd` twins (shipped alongside
 * by the same wrapper). Non-wrapper commands pass through untouched.
 */
export function winLaunchCommand(command: string | null): string | null {
  if (command === "./gradlew") return "./gradlew.bat";
  if (command === "./mvnw") return "./mvnw.cmd";
  return command;
}

export function renderRunPs1(desc: LaunchDescriptor): string {
  const winCommand = winLaunchCommand(desc.command);
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
  if (winCommand) {
    if (desc.build) {
      const winBuild = winLaunchCommand(desc.build.command) ?? desc.build.command;
      after.push(`& ${ps1Quote(winBuild)} ${desc.build.args.map(ps1Quote).join(" ")}`.trimEnd());
      after.push("if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }");
    }
    after.push(`& ${ps1Quote(winCommand)} ${desc.args.map(ps1Quote).join(" ")}`.trimEnd());
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

export type WriteOutcome = "created" | "regenerated" | "preserved" | "overwritten";

/** Options for a (re)generation pass: overwrite hand-edited files / preview only. */
export interface GenerateArtifactsOptions {
  /** Overwrite user-edited scripts too (default preserves them). */
  force?: boolean;
  /** Classify every file without writing anything (preview). */
  dryRun?: boolean;
}

/**
 * Decide the write outcome for one file WITHOUT performing it. A pristine file
 * (its recorded hash matches its current body) is regenerated; a user-edited or
 * marker-less file is preserved unless `force` is set (then overwritten). Kept
 * pure so `dryRun` and the real write share one decision (no drift).
 */
function classifyWrite(
  exists: boolean,
  existing: string | null,
  recompute: (existing: string) => { recorded: string; actual: string } | null,
  force: boolean,
): { outcome: WriteOutcome; write: boolean } {
  if (!exists) return { outcome: "created", write: true };
  const check = existing !== null ? recompute(existing) : null;
  const pristine = check !== null && check.recorded === check.actual;
  if (pristine) return { outcome: "regenerated", write: true };
  // User-edited (or no marker): preserve by default; `force` clobbers it.
  if (force) return { outcome: "overwritten", write: true };
  return { outcome: "preserved", write: false };
}

/**
 * Classify `path` against `content` and write when the decision says so and we
 * are not in dry-run. Preserves user-edited files unless `opts.force`. Returns
 * the outcome regardless of whether a write happened (dry-run reports the same).
 */
async function writeArtifact(
  fs: FileSystemPort,
  path: string,
  content: string,
  recompute: (existing: string) => { recorded: string; actual: string } | null,
  opts: { force: boolean; dryRun: boolean },
): Promise<WriteOutcome> {
  const exists = await fs.exists(path);
  const existing = exists ? await fs.readText(path) : null;
  const { outcome, write } = classifyWrite(exists, existing, recompute, opts.force);
  if (write && !opts.dryRun) await fs.writeText(path, content);
  return outcome;
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
  /** Human-readable run command for the summary (`build && run`), or null when not launchable. */
  run: string | null;
  outcomes: { launchJson: WriteOutcome; runSh: WriteOutcome; runPs1: WriteOutcome };
}

/** The detected command as one line (`npm run build && node dist/main.js`); null when not launchable. */
function formatRun(desc: LaunchDescriptor): string | null {
  if (!desc.command) return null;
  const run = [desc.command, ...desc.args].join(" ").trim();
  if (!desc.build) return run;
  return `${[desc.build.command, ...desc.build.args].join(" ").trim()} && ${run}`;
}

/**
 * Generate (idempotently) the descriptor + per-OS scripts for one source.
 * Pristine files are regenerated, hand-edited ones preserved; `opts.force`
 * overwrites the latter, `opts.dryRun` classifies without writing.
 */
export async function generateSourceLaunchArtifacts(
  fs: FileSystemPort,
  launchDir: string,
  sourcePath: string,
  alias: string,
  opts: GenerateArtifactsOptions = {},
): Promise<SourceArtifactResult> {
  const writeOpts = { force: opts.force ?? false, dryRun: opts.dryRun ?? false };
  const desc = await detectLaunchDescriptor(fs, sourcePath, alias);
  const dir = join(launchDir, alias);
  if (!writeOpts.dryRun) await fs.mkdirp(dir);
  const launchJson = await writeArtifact(
    fs,
    join(dir, "launch.json"),
    renderLaunchJson(desc),
    jsonRecompute,
    writeOpts,
  );
  const runSh = await writeArtifact(
    fs,
    join(dir, "run.sh"),
    renderRunSh(desc),
    shellRecompute,
    writeOpts,
  );
  const runPs1 = await writeArtifact(
    fs,
    join(dir, "run.ps1"),
    renderRunPs1(desc),
    shellRecompute,
    writeOpts,
  );
  return {
    alias,
    stack: desc.stack,
    launchable: desc.command !== null,
    run: formatRun(desc),
    outcomes: { launchJson, runSh, runPs1 },
  };
}
