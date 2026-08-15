import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PathsService } from "./paths-service.js";

export interface BootstrapDsnInput {
  certDsn: string | undefined;
  prodDsn: string | undefined;
}

export interface BootstrapDsnOutput {
  ok: true;
  path: string;
  wrote: string[];
}

export interface WriteDsnValueOutput {
  ok: true;
  path: string;
  key: string;
}

export interface BootstrapDsnError {
  error: string;
  exitCode: 2;
}

interface DsnEntry {
  key: string;
  value: string;
}

export function runBootstrapDsn(
  paths: PathsService,
  input: BootstrapDsnInput,
): BootstrapDsnOutput | BootstrapDsnError {
  const entries: DsnEntry[] = [];
  if (input.certDsn) entries.push({ key: "DB_CERT_DSN", value: input.certDsn });
  if (input.prodDsn) entries.push({ key: "DB_PROD_DSN", value: input.prodDsn });

  if (entries.length === 0) {
    return {
      error:
        "Ni DB_CERT_DSN ni DB_PROD_DSN visibles en el entorno actual. Exportalas en ~/.zshenv (macOS/Linux) o System Environment (Windows) y reabrí Claude Code desde una terminal donde 'echo $DB_CERT_DSN' devuelva valor.",
      exitCode: 2,
    };
  }

  const path = writeDsnValues(paths, entries);
  return { ok: true, path, wrote: entries.map((entry) => entry.key) };
}

export function writeDsnValue(
  paths: PathsService,
  input: { key: string; value: string },
): WriteDsnValueOutput {
  const path = writeDsnValues(paths, [input]);
  return { ok: true, path, key: input.key };
}

/**
 * Upsert of every entry into dsn.env, preserving the lines this call does not
 * own: the file is shared by every connection the user ever bootstrapped, so a
 * whole-file rewrite would drop the DSNs of the other ones.
 */
function writeDsnValues(paths: PathsService, entries: readonly DsnEntry[]): string {
  const target = paths.userDsnFile();
  let lines = readDsnLines(target);
  for (const entry of entries) {
    lines = upsertDsnLine(lines, entry.key, entry.value);
  }

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${lines.join("\n")}\n`, "utf-8");
  try {
    chmodSync(target, 0o600);
  } catch {
    // Best effort: filesystems without POSIX modes (Windows, FAT) must not fail
    // a write that already landed. The DSN is still written.
  }
  return target;
}

function readDsnLines(path: string): string[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf-8").split(/\r?\n/);
  // Only the empty tail the final newline produces is dropped. Blank lines
  // inside the file are the user's own grouping of a file this tool shares with
  // them, and an upsert has no business collapsing it.
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function upsertDsnLine(lines: string[], key: string, value: string): string[] {
  const prefix = `${key}=`;
  const next: string[] = [];
  let replaced = false;
  for (const line of lines) {
    // Compare the line trimmed: an indented assignment still assigns, and
    // leaving it behind would keep a stale credential alive in a file the user
    // believes updated. Duplicates of the same key collapse into the first.
    if (!line.trimStart().startsWith(prefix)) {
      next.push(line);
      continue;
    }
    if (replaced) continue;
    replaced = true;
    next.push(`${key}=${value}`);
  }
  if (!replaced) next.push(`${key}=${value}`);
  return next;
}
