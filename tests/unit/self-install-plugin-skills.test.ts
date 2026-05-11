import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { selfInstallPluginSkills } from "../../src/application/self/install-plugin-skills.js";
import type { ParsedArgs } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";

function makeSkillDir(base: string, name: string, content?: string): string {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    content ??
      `---\nname: ${name}\ndescription: Test skill ${name}\n---\n# ${name}\nSome instructions.`,
  );
  return dir;
}

function buildArgs(values: Record<string, string>, flags: string[] = []): ParsedArgs {
  return {
    rest: ["self", "install-plugin-skills"],
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

describe("selfInstallPluginSkills", () => {
  let fromDir: string;
  let homeDir: string;

  beforeEach(() => {
    fromDir = mkdtempSync(join(tmpdir(), "plugin-skills-from-"));
    homeDir = mkdtempSync(join(tmpdir(), "plugin-skills-home-"));
  });
  afterEach(() => {
    rmSync(fromDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("retorna error si falta --from", async () => {
    const result = await selfInstallPluginSkills(buildArgs({}), buildCtx(homeDir));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("INVALID_INPUT");
  });

  it("retorna error si --target es inválido", async () => {
    makeSkillDir(fromDir, "session");
    const result = await selfInstallPluginSkills(
      buildArgs({ from: fromDir, target: "invalid" }),
      buildCtx(homeDir),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("INVALID_INPUT");
  });

  it("retorna nothing si no hay skills válidos en --from", async () => {
    // directorio vacío, sin subdirectorios
    const result = await selfInstallPluginSkills(
      buildArgs({ from: fromDir, target: "warp" }),
      buildCtx(homeDir),
    );
    expect(result.ok).toBe(true);
    expect(result.data?.status).toBe("nothing");
  });

  it("instala skills en ~/.warp/skills/<name>", async () => {
    makeSkillDir(fromDir, "session");
    makeSkillDir(fromDir, "implement");
    const result = await selfInstallPluginSkills(
      buildArgs({ from: fromDir, target: "warp" }),
      buildCtx(homeDir),
    );
    expect(result.ok).toBe(true);
    expect(result.data?.skills.filter((s) => s.status === "installed")).toHaveLength(2);
    const warpSkillsDir = join(homeDir, ".warp", "skills");
    const installed = readdirSync(warpSkillsDir);
    expect(installed).toContain("session");
    expect(installed).toContain("implement");
  });

  it("con --namespace patchea name: en frontmatter y usa <ns>-<name>", async () => {
    makeSkillDir(fromDir, "session");
    await selfInstallPluginSkills(
      buildArgs({ from: fromDir, target: "warp", namespace: "qtc" }),
      buildCtx(homeDir),
    );
    const destSkillMd = join(homeDir, ".warp", "skills", "qtc-session", "SKILL.md");
    const content = readFileSync(destSkillMd, "utf-8");
    expect(content).toContain("name: qtc-session");
  });

  it("idempotencia: sin --force, segunda corrida retorna skipped", async () => {
    makeSkillDir(fromDir, "session");
    const ctx = buildCtx(homeDir);
    await selfInstallPluginSkills(buildArgs({ from: fromDir, target: "warp" }), ctx);
    const second = await selfInstallPluginSkills(buildArgs({ from: fromDir, target: "warp" }), ctx);
    expect(second.data?.skills[0]?.status).toBe("skipped");
  });

  it("--force sobreescribe instalación existente", async () => {
    makeSkillDir(fromDir, "session");
    const ctx = buildCtx(homeDir);
    await selfInstallPluginSkills(buildArgs({ from: fromDir, target: "warp" }), ctx);
    const second = await selfInstallPluginSkills(
      buildArgs({ from: fromDir, target: "warp" }, ["--force"]),
      ctx,
    );
    expect(second.data?.skills[0]?.status).toBe("installed");
  });

  it("--dry-run no escribe nada en disco", async () => {
    makeSkillDir(fromDir, "session");
    await selfInstallPluginSkills(
      buildArgs({ from: fromDir, target: "warp" }, ["--dry-run"]),
      buildCtx(homeDir),
    );
    const warpSkillsDir = join(homeDir, ".warp", "skills");
    let exists = false;
    try {
      readdirSync(warpSkillsDir);
      exists = true;
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  it("ignora subdirectorios sin SKILL.md válido", async () => {
    makeSkillDir(fromDir, "session");
    mkdirSync(join(fromDir, "no-skill-dir")); // sin SKILL.md
    const result = await selfInstallPluginSkills(
      buildArgs({ from: fromDir, target: "warp" }),
      buildCtx(homeDir),
    );
    expect(result.data?.skills).toHaveLength(1);
    expect(result.data?.skills[0]?.skillName).toBe("session");
  });

  it("instala a ~/.agents/skills cuando target=agents", async () => {
    makeSkillDir(fromDir, "session");
    await selfInstallPluginSkills(
      buildArgs({ from: fromDir, target: "agents" }),
      buildCtx(homeDir),
    );
    const installed = readdirSync(join(homeDir, ".agents", "skills"));
    expect(installed).toContain("session");
  });
});
