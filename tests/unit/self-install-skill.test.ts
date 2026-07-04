import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PathsService } from "../../src/application/paths-service.js";
import { SKILL_DIR_NAME, selfInstallSkill } from "../../src/application/self/install-skill.js";
import type { ParsedArgs } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
import type { EnvPort } from "../../src/ports/env.js";
import type { DirEntry, FileStat, FileSystemPort } from "../../src/ports/file-system.js";
import type { ProcessPort, RunOptions, RunResult } from "../../src/ports/process.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import type { ResolvedRuntime } from "../../src/runtime/types.js";

class FakeEnv implements EnvPort {
  constructor(private home: string) {}
  get() {
    return undefined;
  }
  homeDir() {
    return this.home;
  }
  cwd() {
    return this.home;
  }
}

class RealFs implements FileSystemPort {
  async readText(path: string): Promise<string> {
    return readFile(path, "utf8");
  }
  async writeText(path: string, content: string): Promise<void> {
    await writeFile(path, content, "utf8");
  }
  async exists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }
  async list(_path: string): Promise<DirEntry[]> {
    return [];
  }
  async mkdirp(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  }
  async stat(_path: string): Promise<FileStat> {
    throw new Error("nyi");
  }
}

class FakeProcess implements ProcessPort {
  public lastInvocation: { cmd: string; args: string[] } | undefined;
  async run(cmd: string, args: string[], _opts?: RunOptions): Promise<RunResult> {
    this.lastInvocation = { cmd, args };
    return { code: 1, stdout: "", stderr: `unexpected: ${cmd} ${args.join(" ")}` };
  }
  async which(_cmd: string): Promise<string | undefined> {
    return undefined;
  }

  async spawnDetached() {
    throw new Error("spawnDetached not implemented in this fake");
  }
  async spawnInTerminal() {
    throw new Error("spawnInTerminal not implemented in this fake");
  }
  async killTree(): Promise<void> {}
  async isAlive() {
    return false;
  }
}

function buildArgs(values: Record<string, string>, flags: string[]): ParsedArgs {
  return {
    rest: ["install-skill"],
    plugin: {},
    flags: new Set(flags),
    values: new Map(Object.entries(values)),
    valuesMulti: new Map(),
  };
}

function buildCtx(home: string, fs: FileSystemPort, process: ProcessPort): CliContext {
  const ns = normalizeNamespace("agent-workflow");
  const paths = new PathsService(ns, home, home);
  const runtime: ResolvedRuntime = {
    packageName: "@tacuchi/agent-workflow-cli",
    binName: "agent-workflow",
    source: "default",
  };
  return {
    fs,
    env: new FakeEnv(home),
    process,
    git: {} as never,
    namespace: { namespace: ns, source: "default" },
    runtime,
    paths,
  };
}

const validSkillContent = `---
name: agent-workflow
description: Universal skill for the agent-workflow CLI.
version: 1.1.0
---

# agent-workflow
Body.
`;

async function makeFakeRepo(root: string, withFrontmatter = true): Promise<void> {
  await mkdir(join(root, "references"), { recursive: true });
  await mkdir(join(root, ".git"), { recursive: true });
  await writeFile(
    join(root, "SKILL.md"),
    withFrontmatter ? validSkillContent : "# no frontmatter\n",
    "utf8",
  );
  await writeFile(join(root, "README.md"), "# readme\n", "utf8");
  await writeFile(join(root, "references/session-mgmt.md"), "# session-mgmt\n", "utf8");
  await writeFile(join(root, ".git/HEAD"), "ref: refs/heads/main\n", "utf8");
}

// Fixture de comandos del bundle: dos commands/*.md con el binding Claude
// (frontmatter description/argument-hint/allowed-tools) + referencias
// bundle-relativas `../…`, un README.md que NUNCA debe instalarse como
// comando, y el árbol de loops (LOOP.md — no SKILL.md, no indexable).
const QUICK_COMMAND = `---
description: Lightweight shortcut for scoped work. Starts quick-loop.
argument-hint: <prompt with the scoped task>
allowed-tools:
  [
    "Bash",
  ]
---

# quick — trampoline

Read \`../loops/quick-loop/LOOP.md\` and follow it taking \`$ARGUMENTS\` as the task.
`;

async function seedCommandsFixture(root: string): Promise<void> {
  await mkdir(join(root, "commands"), { recursive: true });
  await mkdir(join(root, "loops/quick-loop"), { recursive: true });
  await writeFile(join(root, "commands/quick.md"), QUICK_COMMAND, "utf8");
  await writeFile(
    join(root, "commands/status.md"),
    '---\ndescription: Read-only dashboard with "quotes" and \\backslash.\n---\n\n# status\n\nRun `aw status` with `$ARGUMENTS`.\nBody edge cases: path C:\\temp and a """triple""" run.\n',
    "utf8",
  );
  await writeFile(join(root, "commands/README.md"), "# commands index\n", "utf8");
  await writeFile(
    join(root, "loops/quick-loop/LOOP.md"),
    "---\nname: quick-loop\ndescription: Quick loop.\n---\n\n# quick-loop\n",
    "utf8",
  );
}

describe("splitCommandDoc", () => {
  it("parses plain, quoted and block-scalar descriptions", async () => {
    const { splitCommandDoc } = await import("../../src/application/self/install-skill.js");
    expect(splitCommandDoc("---\ndescription: plain one\n---\n\nbody\n")).toEqual({
      description: "plain one",
      body: "body\n",
    });
    expect(
      splitCommandDoc('---\ndescription: "quoted: with colon"\n---\n\nbody\n').description,
    ).toBe("quoted: with colon");
    expect(
      splitCommandDoc(
        "---\ndescription: >-\n  folded line one\n  and two\nargument-hint: x\n---\n\nbody\n",
      ).description,
    ).toBe("folded line one and two");
    expect(splitCommandDoc("no frontmatter\n")).toEqual({
      description: null,
      body: "no frontmatter\n",
    });
  });
});

describe("selfInstallSkill", () => {
  let workdir: string;
  let home: string;
  let source: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "aw-skill-test-"));
    home = join(workdir, "home");
    source = join(workdir, "source");
    await mkdir(home, { recursive: true });
    await makeFakeRepo(source);
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it("default --target=all installs into all 7 hosts (claude/codex/warp/oz + gemini/opencode/crush)", async () => {
    const fs = new RealFs();
    const proc = new FakeProcess();
    const ctx = buildCtx(home, fs, proc);
    const args = buildArgs({ from: source, target: "all" }, ["--confirm-all"]);

    const result = await selfInstallSkill(args, ctx);

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    if (result.ok && result.data) {
      expect(result.data.status).toBe("installed");
      expect(result.data.source_kind).toBe("path");
      expect(result.data.dests).toHaveLength(7);
      const claudeDest = result.data.dests.find((d) => d.target === "claude");
      const codexDest = result.data.dests.find((d) => d.target === "codex");
      const opencodeDest = result.data.dests.find((d) => d.target === "opencode");
      const geminiDest = result.data.dests.find((d) => d.target === "gemini");
      const crushDest = result.data.dests.find((d) => d.target === "crush");
      expect(claudeDest?.dest).toBe(join(home, ".claude/skills", SKILL_DIR_NAME));
      expect(codexDest?.dest).toBe(join(home, ".codex/skills", SKILL_DIR_NAME));
      expect(opencodeDest?.dest).toBe(join(home, ".opencode/skills", SKILL_DIR_NAME));
      expect(geminiDest?.dest).toBe(join(home, ".gemini/skills", SKILL_DIR_NAME));
      expect(crushDest?.dest).toBe(join(home, ".crush/skills", SKILL_DIR_NAME));
      expect(claudeDest?.overwrote_existing).toBe(false);
      expect(codexDest?.overwrote_existing).toBe(false);
      expect(claudeDest?.files_copied).toBeGreaterThan(0);
      expect(codexDest?.files_copied).toBeGreaterThan(0);
      expect(opencodeDest?.files_copied).toBeGreaterThan(0);
    }

    const claudeSkill = await readFile(
      join(home, ".claude/skills", SKILL_DIR_NAME, "SKILL.md"),
      "utf8",
    );
    const codexSkill = await readFile(
      join(home, ".codex/skills", SKILL_DIR_NAME, "SKILL.md"),
      "utf8",
    );
    expect(claudeSkill).toContain("name: agent-workflow");
    expect(codexSkill).toContain("name: agent-workflow");

    // .git should NOT be copied (in either target)
    expect(await fs.exists(join(home, ".claude/skills", SKILL_DIR_NAME, ".git"))).toBe(false);
    expect(await fs.exists(join(home, ".codex/skills", SKILL_DIR_NAME, ".git"))).toBe(false);
  });

  it("--target=claude installs only to ~/.claude/skills/", async () => {
    const fs = new RealFs();
    const proc = new FakeProcess();
    const ctx = buildCtx(home, fs, proc);

    const result = await selfInstallSkill(buildArgs({ from: source, target: "claude" }, []), ctx);

    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.dests).toHaveLength(1);
      expect(result.data.dests[0]?.target).toBe("claude");
    }
    expect(await fs.exists(join(home, ".claude/skills", SKILL_DIR_NAME))).toBe(true);
    expect(await fs.exists(join(home, ".codex/skills", SKILL_DIR_NAME))).toBe(false);
  });

  it("--target=codex installs only to ~/.codex/skills/", async () => {
    const fs = new RealFs();
    const proc = new FakeProcess();
    const ctx = buildCtx(home, fs, proc);

    const result = await selfInstallSkill(buildArgs({ from: source, target: "codex" }, []), ctx);

    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.dests).toHaveLength(1);
      expect(result.data.dests[0]?.target).toBe("codex");
    }
    expect(await fs.exists(join(home, ".codex/skills", SKILL_DIR_NAME))).toBe(true);
    expect(await fs.exists(join(home, ".claude/skills", SKILL_DIR_NAME))).toBe(false);
  });

  it("--target=warp installs only to ~/.warp/skills/", async () => {
    const fs = new RealFs();
    const proc = new FakeProcess();
    const ctx = buildCtx(home, fs, proc);

    const result = await selfInstallSkill(buildArgs({ from: source, target: "warp" }, []), ctx);

    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.dests).toHaveLength(1);
      expect(result.data.dests[0]?.target).toBe("warp");
      expect(result.data.dests[0]?.dest).toBe(join(home, ".warp/skills", SKILL_DIR_NAME));
    }
    expect(await fs.exists(join(home, ".warp/skills", SKILL_DIR_NAME))).toBe(true);
    expect(await fs.exists(join(home, ".claude/skills", SKILL_DIR_NAME))).toBe(false);
  });

  it("skill-as-command (codex): sintetiza w-<cmd>/SKILL.md con refs reescritas y barre w-* previos", async () => {
    await seedCommandsFixture(source);
    const fs = new RealFs();
    const ctx = buildCtx(home, fs, new FakeProcess());
    // Resto del modelo anterior (flatten de loops ≤v18) que debe barrerse:
    // fingerprint = dir `w-<name>` con frontmatter `name: <name>`.
    await mkdir(join(home, ".codex/skills/w-quick-loop"), { recursive: true });
    await writeFile(
      join(home, ".codex/skills/w-quick-loop/SKILL.md"),
      "---\nname: quick-loop\ndescription: stale flatten copy\n---\n",
      "utf8",
    );
    // Skill AJENA cuyo nombre solo comparte el prefijo (name == dir): se preserva.
    await mkdir(join(home, ".codex/skills/w-scraper"), { recursive: true });
    await writeFile(
      join(home, ".codex/skills/w-scraper/SKILL.md"),
      "---\nname: w-scraper\ndescription: user skill\n---\n",
      "utf8",
    );
    // Dir de comandos inerte escrito por ≤v18 — Codex nunca lo leyó; se limpia.
    await mkdir(join(home, ".codex/commands/w"), { recursive: true });
    await writeFile(join(home, ".codex/commands/w/quick.md"), "stale\n", "utf8");

    const result = await selfInstallSkill(buildArgs({ from: source, target: "codex" }, []), ctx);

    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      const dest = result.data.dests[0];
      expect(dest?.command_skills).toBe(2); // quick + status; README excluido
      expect(dest?.command_skills_warnings).toBeUndefined();
      // No hay commands dir en Codex: instala skills sintetizadas y lo explica.
      expect(dest?.user_commands_dest).toBeUndefined();
      expect(dest?.user_commands_warning).toContain("skill-as-command");
      expect(dest?.cleaned_legacy).toContain(join(home, ".codex/commands/w"));
    }

    const synth = await readFile(join(home, ".codex/skills/w-quick/SKILL.md"), "utf8");
    expect(synth).toContain("name: w-quick");
    expect(synth).toContain("Lightweight shortcut for scoped work");
    // Referencia bundle-relativa reescrita para resolver desde la skill hermana.
    expect(synth).toContain("../w/loops/quick-loop/LOOP.md");
    expect(synth).not.toContain("`../loops/");
    // El wrapper explica el binding de $ARGUMENTS para hosts sin sustitución.
    expect(synth).toContain("$ARGUMENTS");
    // Barrido con propiedad: el flatten viejo desaparece, la skill ajena
    // `w-scraper` se preserva; el bundle queda intacto.
    expect(await fs.exists(join(home, ".codex/skills/w-quick-loop"))).toBe(false);
    expect(await fs.exists(join(home, ".codex/skills/w-scraper"))).toBe(true);
    expect(await fs.exists(join(home, ".codex/skills/w/loops/quick-loop/LOOP.md"))).toBe(true);
    expect(await fs.exists(join(home, ".codex/commands/w"))).toBe(false);

    // Re-instalar barre y regenera los wrappers propios (marker) sin tocar lo ajeno.
    const again = await selfInstallSkill(
      buildArgs({ from: source, target: "codex" }, ["--force"]),
      ctx,
    );
    expect(again.ok).toBe(true);
    expect(await fs.exists(join(home, ".codex/skills/w-quick/SKILL.md"))).toBe(true);
    expect(await fs.exists(join(home, ".codex/skills/w-scraper"))).toBe(true);
  });

  it("--skill-only omite los wrappers: ni skills sintetizadas (codex) ni commands dir (claude)", async () => {
    await seedCommandsFixture(source);
    const fs = new RealFs();
    const ctx = buildCtx(home, fs, new FakeProcess());

    const codex = await selfInstallSkill(
      buildArgs({ from: source, target: "codex" }, ["--skill-only"]),
      ctx,
    );
    const claude = await selfInstallSkill(
      buildArgs({ from: source, target: "claude" }, ["--skill-only"]),
      ctx,
    );

    expect(codex.ok).toBe(true);
    expect(claude.ok).toBe(true);
    if (codex.ok && codex.data) {
      expect(codex.data.dests[0]?.command_skills).toBeUndefined();
    }
    expect(await fs.exists(join(home, ".codex/skills/w"))).toBe(true);
    expect(await fs.exists(join(home, ".codex/skills/w-quick"))).toBe(false);
    expect(await fs.exists(join(home, ".claude/commands/w"))).toBe(false);
  });

  it("skill-as-command (warp + oz): mismas skills sintetizadas junto al bundle", async () => {
    await seedCommandsFixture(source);
    const fs = new RealFs();
    const ctx = buildCtx(home, fs, new FakeProcess());

    const warp = await selfInstallSkill(buildArgs({ from: source, target: "warp" }, []), ctx);
    const oz = await selfInstallSkill(buildArgs({ from: source, target: "oz" }, []), ctx);

    expect(warp.ok).toBe(true);
    expect(oz.ok).toBe(true);
    expect(await fs.exists(join(home, ".warp/skills/w-quick/SKILL.md"))).toBe(true);
    expect(await fs.exists(join(home, ".agents/skills/w-status/SKILL.md"))).toBe(true);
  });

  it("native wrappers: gemini TOML ({{args}}), opencode description-only, crush body-only", async () => {
    await seedCommandsFixture(source);
    const fs = new RealFs();
    const ctx = buildCtx(home, fs, new FakeProcess());

    for (const target of ["gemini", "opencode", "crush"]) {
      const result = await selfInstallSkill(buildArgs({ from: source, target }, []), ctx);
      expect(result.ok).toBe(true);
    }

    // Gemini: /w:quick vía ~/.gemini/commands/w/quick.toml, $ARGUMENTS → {{args}}.
    const toml = await readFile(join(home, ".gemini/commands/w/quick.toml"), "utf8");
    expect(toml).toContain(
      'description = "Lightweight shortcut for scoped work. Starts quick-loop."',
    );
    expect(toml).toContain('prompt = """');
    expect(toml).toContain("{{args}}");
    expect(toml).not.toContain("$ARGUMENTS");
    // Escapes TOML: comillas y backslash de la description sobreviven.
    const statusToml = await readFile(join(home, ".gemini/commands/w/status.toml"), "utf8");
    expect(statusToml).toContain(
      'description = "Read-only dashboard with \\"quotes\\" and \\\\backslash."',
    );
    // Y en el CUERPO (multi-line basic string): backslash escapado y toda
    // corrida de `"""` neutralizada para no cerrar el string.
    expect(statusToml).toContain("path C:\\\\temp");
    expect(statusToml).toContain('""\\"triple""\\"');

    // OpenCode: /w/quick vía ~/.opencode/command/w/quick.md — solo description
    // en el frontmatter (sin claves del binding Claude), $ARGUMENTS nativo.
    const oc = await readFile(join(home, ".opencode/command/w/quick.md"), "utf8");
    expect(oc).toContain("description: Lightweight shortcut");
    expect(oc).not.toContain("allowed-tools");
    expect(oc).toContain("$ARGUMENTS");

    // Crush: user:w:quick vía ~/.crush/commands/w/quick.md — sin frontmatter.
    const crush = await readFile(join(home, ".crush/commands/w/quick.md"), "utf8");
    expect(crush.startsWith("# quick — trampoline")).toBe(true);
    expect(crush).not.toContain("---");
    expect(crush).toContain("$ARGUMENTS");
    // README.md nunca se instala como comando.
    expect(await fs.exists(join(home, ".crush/commands/w/README.md"))).toBe(false);
  });

  it("--target=oz installs only to ~/.agents/skills/", async () => {
    const fs = new RealFs();
    const proc = new FakeProcess();
    const ctx = buildCtx(home, fs, proc);

    const result = await selfInstallSkill(buildArgs({ from: source, target: "oz" }, []), ctx);

    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.dests).toHaveLength(1);
      expect(result.data.dests[0]?.target).toBe("oz");
      expect(result.data.dests[0]?.dest).toBe(join(home, ".agents/skills", SKILL_DIR_NAME));
    }
    expect(await fs.exists(join(home, ".agents/skills", SKILL_DIR_NAME))).toBe(true);
    expect(await fs.exists(join(home, ".warp/skills", SKILL_DIR_NAME))).toBe(false);
  });

  it("--target=invalid is rejected with INVALID_TARGET", async () => {
    const fs = new RealFs();
    const proc = new FakeProcess();
    const ctx = buildCtx(home, fs, proc);

    const result = await selfInstallSkill(buildArgs({ from: source, target: "vscode" }, []), ctx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_TARGET");
    }
  });

  it("rejects when destination exists without --force (any target with conflict)", async () => {
    const fs = new RealFs();
    const proc = new FakeProcess();
    const ctx = buildCtx(home, fs, proc);
    const claudeDest = join(home, ".claude/skills", SKILL_DIR_NAME);
    await mkdir(claudeDest, { recursive: true });
    await writeFile(join(claudeDest, "SKILL.md"), "old\n", "utf8");

    const result = await selfInstallSkill(
      buildArgs({ from: source, target: "all" }, ["--confirm-all"]),
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("DEST_EXISTS");
      expect(result.error.message).toContain("--force");
    }

    // Old content preserved; codex not created either.
    const old = await readFile(join(claudeDest, "SKILL.md"), "utf8");
    expect(old).toBe("old\n");
    expect(await fs.exists(join(home, ".codex/skills", SKILL_DIR_NAME))).toBe(false);
  });

  it("overwrites existing dest with --force; reports overwrote_existing per target", async () => {
    const fs = new RealFs();
    const proc = new FakeProcess();
    const ctx = buildCtx(home, fs, proc);
    const claudeDest = join(home, ".claude/skills", SKILL_DIR_NAME);
    await mkdir(claudeDest, { recursive: true });
    await writeFile(join(claudeDest, "SKILL.md"), "old\n", "utf8");

    const result = await selfInstallSkill(
      buildArgs({ from: source, target: "all" }, ["--confirm-all", "--force"]),
      ctx,
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      const claude = result.data.dests.find((d) => d.target === "claude");
      const codex = result.data.dests.find((d) => d.target === "codex");
      expect(claude?.overwrote_existing).toBe(true);
      expect(codex?.overwrote_existing).toBe(false);
    }

    const fresh = await readFile(join(claudeDest, "SKILL.md"), "utf8");
    expect(fresh).toContain("name: agent-workflow");
  });

  it("--dry-run does not write anything; dests reports preview per target", async () => {
    const fs = new RealFs();
    const proc = new FakeProcess();
    const ctx = buildCtx(home, fs, proc);

    const result = await selfInstallSkill(
      buildArgs({ from: source, target: "all" }, ["--dry-run"]),
      ctx,
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.status).toBe("dry-run");
      expect(result.data.dests).toHaveLength(7);
      expect(result.data.dests.every((d) => d.status === "dry-run")).toBe(true);
    }

    expect(await fs.exists(join(home, ".claude/skills", SKILL_DIR_NAME))).toBe(false);
    expect(await fs.exists(join(home, ".codex/skills", SKILL_DIR_NAME))).toBe(false);
  });

  it("rejects local source missing SKILL.md", async () => {
    const fs = new RealFs();
    const proc = new FakeProcess();
    const ctx = buildCtx(home, fs, proc);
    const badSource = join(workdir, "bad");
    await mkdir(badSource, { recursive: true });

    const result = await selfInstallSkill(
      buildArgs({ from: badSource, target: "all" }, ["--confirm-all"]),
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_SKILL_REPO");
    }
  });

  it("rejects local source with invalid SKILL.md frontmatter", async () => {
    const fs = new RealFs();
    const proc = new FakeProcess();
    const ctx = buildCtx(home, fs, proc);
    const invalidSource = join(workdir, "invalid");
    await makeFakeRepo(invalidSource, false);

    const result = await selfInstallSkill(
      buildArgs({ from: invalidSource, target: "all" }, ["--confirm-all"]),
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_SKILL_FRONTMATTER");
    }
  });

  it("rejects nonexistent local path", async () => {
    const fs = new RealFs();
    const proc = new FakeProcess();
    const ctx = buildCtx(home, fs, proc);

    const result = await selfInstallSkill(
      buildArgs({ from: join(workdir, "does-not-exist"), target: "all" }, ["--confirm-all"]),
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SOURCE_NOT_FOUND");
    }
  });

  it("rejects --from <https URL> with INVALID_SOURCE (bundled-only since v3.0.2)", async () => {
    const fs = new RealFs();
    const proc = new FakeProcess();
    const ctx = buildCtx(home, fs, proc);

    const result = await selfInstallSkill(
      buildArgs({ from: "https://github.com/Tacuchi/agent-workflow-manager.git", target: "all" }, [
        "--confirm-all",
      ]),
      ctx,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_SOURCE");
      expect(result.error.message).toContain("bundled");
    }
    expect(proc.lastInvocation).toBeUndefined();
  });

  it("rejects --from git@... ssh URL with INVALID_SOURCE", async () => {
    const fs = new RealFs();
    const proc = new FakeProcess();
    const ctx = buildCtx(home, fs, proc);

    const result = await selfInstallSkill(
      buildArgs({ from: "git@github.com:Tacuchi/agent-workflow-cli.git", target: "all" }, [
        "--confirm-all",
      ]),
      ctx,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_SOURCE");
    }
  });

  it("uses bundled skill when --from is not provided", async () => {
    const fs = new RealFs();
    const proc = new FakeProcess();
    const ctx = buildCtx(home, fs, proc);

    const result = await selfInstallSkill(
      buildArgs({ target: "all" }, ["--confirm-all"]),
      ctx,
      async () => source,
    );

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    if (result.ok && result.data) {
      expect(result.data.source_kind).toBe("bundled");
      expect(result.data.source).toBe(source);
      expect(result.data.status).toBe("installed");
    }

    const installed = await readFile(
      join(home, ".claude/skills", SKILL_DIR_NAME, "SKILL.md"),
      "utf8",
    );
    expect(installed).toContain("name: agent-workflow");

    expect(proc.lastInvocation).toBeUndefined();
  });

  it("returns BUNDLED_NOT_FOUND when bundled is missing and --from omitted", async () => {
    const fs = new RealFs();
    const proc = new FakeProcess();
    const ctx = buildCtx(home, fs, proc);

    const result = await selfInstallSkill(
      buildArgs({ target: "all" }, ["--confirm-all"]),
      ctx,
      async () => null,
    );

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    if (!result.ok) {
      expect(result.error.code).toBe("BUNDLED_NOT_FOUND");
      expect(result.error.message).toContain("--from");
      expect(result.error.message).not.toContain("http");
    }
    expect(proc.lastInvocation).toBeUndefined();
  });

  it("SKILL_DIR_NAME points to the bundled skill name", () => {
    expect(SKILL_DIR_NAME).toBe("w");
  });

  it("install removes legacy agent-workflow skill + commands dirs (cleaned_legacy)", async () => {
    const fs = new RealFs();
    const ctx = buildCtx(home, fs, new FakeProcess());
    // Seed a pre-`w`-rename install on claude.
    const legacySkill = join(home, ".claude/skills/agent-workflow");
    const legacyCmds = join(home, ".claude/commands/agent-workflow");
    await mkdir(legacySkill, { recursive: true });
    await writeFile(join(legacySkill, "SKILL.md"), "---\nname: agent-workflow\n---\n", "utf8");
    await mkdir(legacyCmds, { recursive: true });
    await writeFile(join(legacyCmds, "session.md"), "# session\n", "utf8");

    const result = await selfInstallSkill(buildArgs({ from: source, target: "claude" }, []), ctx);

    expect(result.ok).toBe(true);
    // Legacy artifacts gone, new install present.
    expect(await fs.exists(legacySkill)).toBe(false);
    expect(await fs.exists(legacyCmds)).toBe(false);
    expect(await fs.exists(join(home, ".claude/skills", SKILL_DIR_NAME))).toBe(true);
    if (result.ok && result.data) {
      const claude = result.data.dests.find((d) => d.target === "claude");
      expect(claude?.cleaned_legacy).toEqual(expect.arrayContaining([legacySkill, legacyCmds]));
    }
  });

  it("--keep-legacy preserves the old agent-workflow dirs", async () => {
    const fs = new RealFs();
    const ctx = buildCtx(home, fs, new FakeProcess());
    const legacySkill = join(home, ".claude/skills/agent-workflow");
    await mkdir(legacySkill, { recursive: true });
    await writeFile(join(legacySkill, "SKILL.md"), "---\nname: agent-workflow\n---\n", "utf8");

    const result = await selfInstallSkill(
      buildArgs({ from: source, target: "claude" }, ["--keep-legacy"]),
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(await fs.exists(legacySkill)).toBe(true); // preserved
    if (result.ok && result.data) {
      const claude = result.data.dests.find((d) => d.target === "claude");
      expect(claude?.cleaned_legacy).toBeUndefined();
    }
  });

  it("--target missing → TARGET_REQUIRED", async () => {
    const fs = new RealFs();
    const proc = new FakeProcess();
    const ctx = buildCtx(home, fs, proc);
    const result = await selfInstallSkill(buildArgs({ from: source }, []), ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TARGET_REQUIRED");
      expect(result.error.message).toContain("--target");
    }
  });

  it("--target all without --confirm-all → CONFIRM_ALL_REQUIRED", async () => {
    const fs = new RealFs();
    const proc = new FakeProcess();
    const ctx = buildCtx(home, fs, proc);
    const result = await selfInstallSkill(buildArgs({ from: source, target: "all" }, []), ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CONFIRM_ALL_REQUIRED");
      expect(result.error.message).toContain("--confirm-all");
    }
  });

  it("--target all with --dry-run does NOT require --confirm-all", async () => {
    const fs = new RealFs();
    const proc = new FakeProcess();
    const ctx = buildCtx(home, fs, proc);
    const result = await selfInstallSkill(
      buildArgs({ from: source, target: "all" }, ["--dry-run"]),
      ctx,
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.status).toBe("dry-run");
    }
  });

  it("--target claude without --keep-cache reports cache_cleared", async () => {
    const fs = new RealFs();
    const proc = new FakeProcess();
    const ctx = buildCtx(home, fs, proc);
    const result = await selfInstallSkill(buildArgs({ from: source, target: "claude" }, []), ctx);
    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      const claudeDest = result.data.dests.find((d) => d.target === "claude");
      expect(claudeDest?.cache_cleared).toBe(true);
    }
  });

  it("--keep-cache skips pre-clear (cache_cleared=false)", async () => {
    const fs = new RealFs();
    const proc = new FakeProcess();
    const ctx = buildCtx(home, fs, proc);
    const result = await selfInstallSkill(
      buildArgs({ from: source, target: "claude" }, ["--keep-cache"]),
      ctx,
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      const claudeDest = result.data.dests.find((d) => d.target === "claude");
      expect(claudeDest?.cache_cleared).toBe(false);
    }
  });
});
