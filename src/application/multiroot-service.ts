// Mirror de qtc_core/multiroot.py: cmd_attach_multiroot + cmd_detach_multiroot.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { parseProjectBlock } from "./parsers/project-block.js";

export interface MultirootInput {
  paths?: string[];
  pathsCsv?: string;
  fromSources?: boolean;
  useGlobal?: boolean;
  workspace?: string;
  skipClaude?: boolean;
  skipCodex?: boolean;
}

export interface MultirootError {
  error: string;
  hint?: string;
}

export interface MultirootResult {
  scope: "global" | "workspace";
  scope_dir: string;
  paths_input: string[];
  claude: ClaudeResult | { skipped: true };
  codex: CodexResult | { skipped: true };
}

interface ClaudeAttachOk {
  file: string;
  backup: string | null;
  added: string[];
  already_present: string[];
  written: boolean;
}
interface ClaudeDetachOk {
  file: string;
  backup: string | null;
  removed: string[];
  not_present: string[];
  written: boolean;
}
interface ClaudeFail {
  file: string;
  error: string;
  detail?: string;
  skipped: true;
}
type ClaudeResult = ClaudeAttachOk | ClaudeDetachOk | ClaudeFail;

interface CodexAttachOk {
  file: string;
  backup: string | null;
  additional_writable_roots: { added: string[]; already_present: string[] };
  projects_trusted: { added: string[]; already_present: string[] };
  written: boolean;
}
interface CodexDetachOk {
  file: string;
  backup: string | null;
  additional_writable_roots: { removed: string[]; not_present: string[] };
  projects_trusted: {
    removed: string[];
    not_present: string[];
    skipped: { path: string; reason: string }[];
  };
  written: boolean;
}
type CodexResult = CodexAttachOk | CodexDetachOk;

type Mode = "attach" | "detach";

export async function runMultiroot(
  fs: FileSystemPort,
  env: EnvPort,
  mode: Mode,
  input: MultirootInput,
): Promise<MultirootResult | MultirootError> {
  const { paths, scopeDir, scope } = await resolveScopeAndPaths(fs, env, input);

  if (input.fromSources && paths.length === 0) {
    return {
      error: "no_sources_in_qtc_project",
      hint: "El bloque QTC-PROJECT no declara fuentes; pasá --path explícito.",
    };
  }
  if (paths.length === 0) {
    return {
      error: "no_paths_provided",
      hint: "Usá --path <path> [--path <path2>...] o --from-sources.",
    };
  }

  const result: MultirootResult = {
    scope,
    scope_dir: scopeDir,
    paths_input: paths,
    claude: input.skipClaude
      ? { skipped: true }
      : mode === "attach"
        ? attachClaude(paths, scopeDir)
        : detachClaude(paths, scopeDir),
    codex: input.skipCodex
      ? { skipped: true }
      : mode === "attach"
        ? attachCodex(paths, scopeDir)
        : detachCodex(paths, scopeDir),
  };
  return result;
}

async function resolveScopeAndPaths(
  fs: FileSystemPort,
  env: EnvPort,
  input: MultirootInput,
): Promise<{ paths: string[]; scopeDir: string; scope: "global" | "workspace" }> {
  let paths: string[] = [];
  if (input.paths) paths.push(...input.paths);
  if (input.pathsCsv) {
    paths.push(
      ...input.pathsCsv
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p.length > 0),
    );
  }
  if (input.fromSources) {
    paths = await readSourcesFromProject(fs, env);
  }

  let scopeDir: string;
  let scope: "global" | "workspace";
  if (input.useGlobal) {
    scopeDir = homedir();
    scope = "global";
  } else if (input.workspace) {
    scopeDir = resolve(input.workspace);
    scope = "workspace";
  } else {
    scopeDir = resolve(env.cwd());
    scope = "workspace";
  }
  return { paths, scopeDir, scope };
}

async function readSourcesFromProject(fs: FileSystemPort, env: EnvPort): Promise<string[]> {
  const cwd = env.cwd();
  for (const file of [join(cwd, "CLAUDE.md"), join(cwd, "AGENTS.md")]) {
    if (!(await fs.exists(file))) continue;
    const block = parseProjectBlock(await fs.readText(file));
    if (block && block.fuentes.length > 0) {
      return block.fuentes.map((f) => f.path).filter((p) => p && p.length > 0);
    }
  }
  return [];
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

function toCodexPath(p: string): string {
  const np = normalizePath(p);
  return process.platform === "win32" ? np.replace(/\//g, "\\") : np;
}

function backupFile(path: string): string | null {
  if (!existsSync(path)) return null;
  const ts = Math.floor(Date.now() / 1000);
  const backupPath = withSuffixAdd(path, `.bak.${ts}`);
  copyFileSync(path, backupPath);
  return backupPath;
}

function withSuffixAdd(path: string, extra: string): string {
  // Mirror Python `Path.with_suffix(suffix + extra)` — appends to existing suffix.
  return `${path}${extra}`;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Claude ─────────────────────────────────────────────────────────────────

function claudeSettingsPath(scopeDir: string): string {
  return join(scopeDir, ".claude", "settings.json");
}

function attachClaude(paths: string[], scopeDir: string): ClaudeResult {
  const settingsFile = claudeSettingsPath(scopeDir);
  mkdirSync(join(scopeDir, ".claude"), { recursive: true });

  let data: Record<string, unknown> = {};
  if (existsSync(settingsFile)) {
    try {
      data = JSON.parse(readFileSync(settingsFile, "utf-8"));
    } catch (e) {
      return {
        file: settingsFile,
        error: "invalid_json",
        detail: (e as Error).message,
        skipped: true,
      };
    }
  }
  const perms = ((): Record<string, unknown> => {
    if (!isRecord(data.permissions)) data.permissions = {};
    return data.permissions as Record<string, unknown>;
  })();
  if (!Array.isArray(perms.additionalDirectories)) perms.additionalDirectories = [];
  const additional = perms.additionalDirectories as unknown[];
  if (!Array.isArray(additional)) {
    return {
      file: settingsFile,
      error: "additionalDirectories_not_list",
      skipped: true,
    };
  }
  const existingNorm = new Set(
    additional.filter((p): p is string => typeof p === "string").map(normalizePath),
  );
  const added: string[] = [];
  const already: string[] = [];
  for (const raw of paths) {
    const np = normalizePath(raw);
    if (existingNorm.has(np)) {
      already.push(np);
    } else {
      additional.push(np);
      existingNorm.add(np);
      added.push(np);
    }
  }
  let backup: string | null = null;
  if (added.length > 0) {
    backup = backupFile(settingsFile);
    writeFileSync(settingsFile, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
  }
  return { file: settingsFile, backup, added, already_present: already, written: added.length > 0 };
}

function detachClaude(paths: string[], scopeDir: string): ClaudeResult {
  const settingsFile = claudeSettingsPath(scopeDir);
  if (!existsSync(settingsFile)) {
    return {
      file: settingsFile,
      backup: null,
      removed: [],
      not_present: paths.map(normalizePath),
      written: false,
    };
  }
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(readFileSync(settingsFile, "utf-8"));
  } catch (e) {
    return {
      file: settingsFile,
      error: "invalid_json",
      detail: (e as Error).message,
      skipped: true,
    };
  }
  const perms = isRecord(data.permissions) ? data.permissions : {};
  const additional = (perms as Record<string, unknown>).additionalDirectories;
  if (!Array.isArray(additional)) {
    return {
      file: settingsFile,
      backup: null,
      removed: [],
      not_present: paths.map(normalizePath),
      written: false,
    };
  }
  const targetNorm = new Set(paths.map(normalizePath));
  const newList: unknown[] = [];
  const removed: string[] = [];
  for (const x of additional) {
    if (typeof x === "string" && targetNorm.has(normalizePath(x))) {
      removed.push(normalizePath(x));
    } else {
      newList.push(x);
    }
  }
  const removedSet = new Set(removed);
  const notPresent: string[] = [];
  for (const p of targetNorm) {
    if (!removedSet.has(p)) notPresent.push(p);
  }
  let backup: string | null = null;
  let written = false;
  if (removed.length > 0) {
    backup = backupFile(settingsFile);
    (perms as Record<string, unknown>).additionalDirectories = newList;
    data.permissions = perms;
    writeFileSync(settingsFile, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
    written = true;
  }
  return { file: settingsFile, backup, removed, not_present: notPresent, written };
}

// ─── Codex ──────────────────────────────────────────────────────────────────

function codexConfigPath(scopeDir: string): string {
  return join(scopeDir, ".codex", "config.toml");
}

function updateWritableRoots(
  content: string,
  pathsCodex: string[],
): { content: string; added: string[]; already: string[] } {
  const re = /^additional_writable_roots\s*=\s*\[([\s\S]*?)\]/m;
  const match = content.match(re);
  const added: string[] = [];
  const already: string[] = [];
  if (match && match.index !== undefined) {
    const existingBlock = match[1] ?? "";
    const existing = [...existingBlock.matchAll(/["']([^"']+)["']/g)].map((m) => m[1] as string);
    const existingNorm = new Set(existing.map(normalizePath));
    const merged = [...existing];
    for (const p of pathsCodex) {
      if (existingNorm.has(normalizePath(p))) {
        already.push(p);
      } else {
        merged.push(p);
        existingNorm.add(normalizePath(p));
        added.push(p);
      }
    }
    if (added.length > 0) {
      const formatted = merged.map((p) => `  "${p}"`).join(",\n");
      const replacement = `additional_writable_roots = [\n${formatted}\n]`;
      const newContent =
        content.slice(0, match.index) + replacement + content.slice(match.index + match[0].length);
      return { content: newContent, added, already };
    }
    return { content, added, already };
  }
  const formatted = pathsCodex.map((p) => `  "${p}"`).join(",\n");
  const insertion = `additional_writable_roots = [\n${formatted}\n]\n\n`;
  const firstSection = content.match(/^\[/m);
  let newContent: string;
  if (firstSection?.index !== undefined) {
    newContent =
      content.slice(0, firstSection.index) + insertion + content.slice(firstSection.index);
  } else {
    newContent = `${content.replace(/\s+$/, "")}\n\n${insertion}`.replace(/^\s+/, "");
  }
  return { content: newContent, added: [...pathsCodex], already };
}

function ensureProjectTrust(
  content: string,
  pathsCodex: string[],
): { content: string; added: string[]; already: string[] } {
  const added: string[] = [];
  const already: string[] = [];
  let newContent = content;
  for (const p of pathsCodex) {
    const variants = new Set([p]);
    if (!p.startsWith("\\\\?\\")) variants.add(`\\\\?\\${p}`);
    else variants.add(p.slice(4));

    let present = false;
    for (const variant of variants) {
      const esc = escapeRegex(variant);
      if (new RegExp(`^\\[projects\\.'${esc}'\\]`, "m").test(newContent)) {
        present = true;
        break;
      }
      if (new RegExp(`^\\[projects\\."${esc}"\\]`, "m").test(newContent)) {
        present = true;
        break;
      }
    }
    if (present) {
      already.push(p);
      continue;
    }
    const block = `\n[projects.'${p}']\ntrust_level = "trusted"\n`;
    if (!newContent.endsWith("\n")) newContent += "\n";
    newContent += block;
    added.push(p);
  }
  return { content: newContent, added, already };
}

function removeFromWritableRoots(
  content: string,
  pathsCodex: string[],
): { content: string; removed: string[]; notPresent: string[] } {
  const re = /^additional_writable_roots\s*=\s*\[([\s\S]*?)\]/m;
  const match = content.match(re);
  const targetNorm = new Set(pathsCodex.map(normalizePath));
  if (!match || match.index === undefined) {
    return { content, removed: [], notPresent: [...pathsCodex] };
  }
  const existingBlock = match[1] ?? "";
  const existing = [...existingBlock.matchAll(/["']([^"']+)["']/g)].map((m) => m[1] as string);
  const removed: string[] = [];
  const kept: string[] = [];
  for (const p of existing) {
    if (targetNorm.has(normalizePath(p))) removed.push(p);
    else kept.push(p);
  }
  const removedNorm = new Set(removed.map(normalizePath));
  const notPresent: string[] = [];
  for (const p of pathsCodex) {
    if (!removedNorm.has(normalizePath(p))) notPresent.push(p);
  }
  if (removed.length === 0) return { content, removed: [], notPresent };

  let replacement: string;
  if (kept.length > 0) {
    const formatted = kept.map((p) => `  "${p}"`).join(",\n");
    replacement = `additional_writable_roots = [\n${formatted}\n]`;
  } else {
    replacement = "";
  }
  let newContent =
    content.slice(0, match.index) + replacement + content.slice(match.index + match[0].length);
  newContent = newContent.replace(/\n\n\n+/g, "\n\n");
  return { content: newContent, removed, notPresent };
}

function removeProjectTrust(
  content: string,
  pathsCodex: string[],
): {
  content: string;
  removed: string[];
  notPresent: string[];
  skipped: { path: string; reason: string }[];
} {
  const removed: string[] = [];
  const notPresent: string[] = [];
  const skipped: { path: string; reason: string }[] = [];
  let newContent = content;
  for (const p of pathsCodex) {
    const variants = new Set([p]);
    if (!p.startsWith("\\\\?\\")) variants.add(`\\\\?\\${p}`);
    else variants.add(p.slice(4));

    let blockMatch: { start: number; end: number; text: string } | null = null;
    outer: for (const variant of variants) {
      const esc = escapeRegex(variant);
      for (const quote of ["'", '"']) {
        // (?ms) header + body up to next [ or EOF.
        const re = new RegExp(
          `^\\[projects\\.${quote}${esc}${quote}\\]\\s*\\n(?:[ \\t]*[^\\[\\n]*\\n?)*?(?=^\\[|$(?![\\s\\S]))`,
          "ms",
        );
        const m = re.exec(newContent);
        if (m) {
          blockMatch = { start: m.index, end: m.index + m[0].length, text: m[0] };
          break outer;
        }
      }
    }
    if (!blockMatch) {
      notPresent.push(p);
      continue;
    }
    const blockText = blockMatch.text;
    const body = blockText.replace(/^\[projects\..+?\]\s*\n/, "");
    const bodyLines = body
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const isTrivial =
      bodyLines.length === 1 && /^trust_level\s*=\s*"trusted"\s*$/.test(bodyLines[0] ?? "");
    if (!isTrivial) {
      skipped.push({ path: p, reason: "block_has_extra_keys" });
      continue;
    }
    newContent = newContent.slice(0, blockMatch.start) + newContent.slice(blockMatch.end);
    newContent = newContent.replace(/\n\n\n+/g, "\n\n");
    removed.push(p);
  }
  return { content: newContent, removed, notPresent, skipped };
}

function attachCodex(paths: string[], scopeDir: string): CodexResult {
  const configFile = codexConfigPath(scopeDir);
  mkdirSync(join(scopeDir, ".codex"), { recursive: true });
  let content = "";
  if (existsSync(configFile)) content = readFileSync(configFile, "utf-8");

  const pathsCodex = paths.map(toCodexPath);
  const r1 = updateWritableRoots(content, pathsCodex);
  const r2 = ensureProjectTrust(r1.content, pathsCodex);

  let backup: string | null = null;
  let written = false;
  if (r2.content !== content) {
    backup = backupFile(configFile);
    writeFileSync(configFile, r2.content, "utf-8");
    written = true;
  }
  return {
    file: configFile,
    backup,
    additional_writable_roots: { added: r1.added, already_present: r1.already },
    projects_trusted: { added: r2.added, already_present: r2.already },
    written,
  };
}

function detachCodex(paths: string[], scopeDir: string): CodexResult {
  const configFile = codexConfigPath(scopeDir);
  if (!existsSync(configFile)) {
    return {
      file: configFile,
      backup: null,
      additional_writable_roots: { removed: [], not_present: [...paths] },
      projects_trusted: { removed: [], not_present: [...paths], skipped: [] },
      written: false,
    };
  }
  const content = readFileSync(configFile, "utf-8");
  const pathsCodex = paths.map(toCodexPath);
  const r1 = removeFromWritableRoots(content, pathsCodex);
  const r2 = removeProjectTrust(r1.content, pathsCodex);

  let backup: string | null = null;
  let written = false;
  if (r2.content !== content) {
    backup = backupFile(configFile);
    writeFileSync(configFile, r2.content, "utf-8");
    written = true;
  }
  return {
    file: configFile,
    backup,
    additional_writable_roots: { removed: r1.removed, not_present: r1.notPresent },
    projects_trusted: {
      removed: r2.removed,
      not_present: r2.notPresent,
      skipped: r2.skipped,
    },
    written,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
