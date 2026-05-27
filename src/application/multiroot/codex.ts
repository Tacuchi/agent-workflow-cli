import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { backupFile, escapeRegex, normalizePath, toCodexPath } from "./paths.js";

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
export type CodexResult = CodexAttachOk | CodexDetachOk;

export function codexConfigPath(scopeDir: string): string {
  return join(scopeDir, ".codex", "config.toml");
}

export function attachCodex(paths: string[], scopeDir: string): CodexResult {
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

export function detachCodex(paths: string[], scopeDir: string): CodexResult {
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
      const formatted = merged.map((p) => `  '${p}'`).join(",\n");
      const replacement = `additional_writable_roots = [\n${formatted}\n]`;
      const newContent =
        content.slice(0, match.index) + replacement + content.slice(match.index + match[0].length);
      return { content: newContent, added, already };
    }
    return { content, added, already };
  }
  const formatted = pathsCodex.map((p) => `  '${p}'`).join(",\n");
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
    const formatted = kept.map((p) => `  '${p}'`).join(",\n");
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
