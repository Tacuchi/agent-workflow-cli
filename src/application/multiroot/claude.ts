import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { backupFile, normalizePath } from "./paths.js";

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
export type ClaudeResult = ClaudeAttachOk | ClaudeDetachOk | ClaudeFail;

export function claudeSettingsPath(scopeDir: string): string {
  return join(scopeDir, ".claude", "settings.json");
}

export function attachClaude(paths: string[], scopeDir: string): ClaudeResult {
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

export function detachClaude(paths: string[], scopeDir: string): ClaudeResult {
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

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
