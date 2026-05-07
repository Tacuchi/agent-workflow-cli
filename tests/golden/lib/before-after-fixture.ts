import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PathsService } from "../../../src/application/paths-service.js";
import type { EnvPort } from "../../../src/ports/env.js";
import { normalizeNamespace } from "../../../src/runtime/namespace.js";

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

/**
 * Normalizes today's `YYYY-MM-DD` dates (e.g. session-create writes the date
 * the test runs). Replaces every `2026-XX-XX` style date with `DATE` so
 * goldens captured on a different day still compare byte-byte.
 */
export function normalizeTodayDate(text: string): string {
  return text.replace(/\b20\d{2}-\d{2}-\d{2}\b/g, "DATE");
}

/**
 * Constructs a `PathsService` for tests with namespace=workflow, so that all
 * path methods produce `.workflow/...` literals. Used by golden tests when
 * services are migrated to take `paths: PathsService` as a dependency.
 */
export function makeWorkflowPaths(env: TestEnv): PathsService {
  return new PathsService(normalizeNamespace("workflow"), env.homeDir(), env.cwd());
}
