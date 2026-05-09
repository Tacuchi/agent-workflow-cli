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

export function runBootstrapDsn(
  paths: PathsService,
  input: BootstrapDsnInput,
): BootstrapDsnOutput | BootstrapDsnError {
  const target = paths.userDsnFile();
  const lines: string[] = [];
  const written: string[] = [];

  if (input.certDsn) {
    lines.push(`DB_CERT_DSN=${input.certDsn}`);
    written.push("DB_CERT_DSN");
  }
  if (input.prodDsn) {
    lines.push(`DB_PROD_DSN=${input.prodDsn}`);
    written.push("DB_PROD_DSN");
  }

  if (lines.length === 0) {
    return {
      error:
        "Ni DB_CERT_DSN ni DB_PROD_DSN visibles en el entorno actual. Exportalas en ~/.zshenv (macOS/Linux) o System Environment (Windows) y reabrí Claude Code desde una terminal donde 'echo $DB_CERT_DSN' devuelva valor.",
      exitCode: 2,
    };
  }

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${lines.join("\n")}\n`, "utf-8");
  try {
    chmodSync(target, 0o600);
  } catch {
    // ignore chmod failures
  }
  return { ok: true, path: target, wrote: written };
}

export function writeDsnValue(
  paths: PathsService,
  input: { key: string; value: string },
): WriteDsnValueOutput {
  const target = paths.userDsnFile();
  const existing = readDsnLines(target);
  const next = upsertDsnLine(existing, input.key, input.value);

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${next.join("\n")}\n`, "utf-8");
  try {
    chmodSync(target, 0o600);
  } catch {
    // ignore chmod failures
  }
  return { ok: true, path: target, key: input.key };
}

function readDsnLines(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
}

function upsertDsnLine(lines: string[], key: string, value: string): string[] {
  const prefix = `${key}=`;
  let replaced = false;
  const next = lines.map((line) => {
    if (line.startsWith(prefix)) {
      replaced = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!replaced) next.push(`${key}=${value}`);
  return next;
}
