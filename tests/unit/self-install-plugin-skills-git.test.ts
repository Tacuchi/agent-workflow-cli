import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installPluginSkillsFromGit } from "../../src/application/self/install-plugin-skills-git.js";
import type { ParsedArgs } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";

function buildArgs(values: Record<string, string>, flags: string[] = []): ParsedArgs {
  return {
    rest: [],
    plugin: {},
    flags: new Set(flags),
    values: new Map(Object.entries(values)),
    valuesMulti: new Map(),
  };
}

function buildCtx(homeDir: string): CliContext {
  return {
    env: {
      homeDir: () => homeDir,
      cwd: () => homeDir,
      get: () => undefined,
    },
    fs: {
      exists: async (p: string) => {
        try {
          const { stat } = await import("node:fs/promises");
          await stat(p);
          return true;
        } catch {
          return false;
        }
      },
    },
    paths: {} as CliContext["paths"],
  } as unknown as CliContext;
}

describe("installPluginSkillsFromGit", () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "plugin-git-home-"));
  });
  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("retorna error si falta --url", async () => {
    const result = await installPluginSkillsFromGit(buildArgs({}), buildCtx(homeDir));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("INVALID_INPUT");
  });

  it("retorna error si --target es inválido", async () => {
    const result = await installPluginSkillsFromGit(
      buildArgs({ url: "https://example.com/repo.git", target: "invalid" }),
      buildCtx(homeDir),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("INVALID_INPUT");
  });

  it("retorna GIT_CLONE_FAILED cuando la URL no existe", async () => {
    const result = await installPluginSkillsFromGit(
      buildArgs({ url: "https://example.invalid/repo.git#main", target: "warp" }),
      buildCtx(homeDir),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("GIT_CLONE_FAILED");
  });
});
