import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EnvPort } from "../../../src/ports/env.js";

export interface FixtureClone {
  cwd: string;
  cleanup(): void;
}

export function cloneFixture(fixturePath: string, prefix = "agent-workflow-"): FixtureClone {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cpSync(fixturePath, dir, { recursive: true });
  return {
    cwd: dir,
    cleanup() {
      // No-op in tests; OS reaps tmpdir eventually. Avoids accidental rmrf bugs.
    },
  };
}

export class TestEnv implements EnvPort {
  constructor(private readonly cwdValue: string) {}
  get(): undefined {
    return undefined;
  }
  homeDir(): string {
    return "/home/test";
  }
  cwd(): string {
    return this.cwdValue;
  }
}

export function readFile(path: string): string {
  return readFileSync(path, "utf8");
}

/**
 * Normalizes the timestamp on the `- Última actividad:` line so test runs
 * captured at different minutes still compare byte-byte.
 */
export function normalizeLastActivity(text: string): string {
  return text.replace(
    /- Última actividad: \d{4}-\d{2}-\d{2} \d{2}:\d{2}/g,
    "- Última actividad: TS",
  );
}
