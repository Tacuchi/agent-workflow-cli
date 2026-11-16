import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { parseHubBlock } from "../../src/application/parsers/hub-block.js";
import { PathsService } from "../../src/application/paths-service.js";
import { blockFromParsed, renderHubBlock } from "../../src/application/render/hub-block.js";
import { hubBlockUpsertCommand } from "../../src/cli/commands/hub-block.js";
import type { ParsedArgs } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";

const BASE = {
  proyecto: "X",
  fuentes: [{ alias: "core", path: "/p", main_branch: "certificacion" }],
  stack: {},
  lastActivity: "2026-01-01 00:00",
} as const;

describe("project-block default_branches", () => {
  it("renders a 'Ramas por defecto' entry when defaults are declared", () => {
    const out = renderHubBlock({
      ...BASE,
      defaultBranches: { principal: "main", desarrollo: "development", qa: "qa" },
    });
    expect(out).toContain("- Ramas por defecto:");
    expect(out).toContain("  - principal: main");
    expect(out).toContain("  - desarrollo: development");
    expect(out).toContain("  - qa: qa");
  });

  it("renders only the declared roles (partial defaults)", () => {
    const out = renderHubBlock({ ...BASE, defaultBranches: { qa: "release/qa" } });
    expect(out).toContain("  - qa: release/qa");
    expect(out).not.toContain("principal:");
    expect(out).not.toContain("desarrollo:");
  });

  it("omits the entry when defaults are empty/undefined", () => {
    expect(renderHubBlock(BASE)).not.toContain("Ramas por defecto");
    expect(renderHubBlock({ ...BASE, defaultBranches: {} })).not.toContain("Ramas por defecto");
  });

  it("places the entry BEFORE the branch lists (old parsers ignore it there)", () => {
    const out = renderHubBlock({
      ...BASE,
      defaultBranches: { principal: "main" },
      workingBranches: { core: "feature/x" },
      qaBranches: { core: "desarrollo" },
    });
    expect(out.indexOf("- Ramas por defecto:")).toBeLessThan(
      out.indexOf("- Ramas de trabajo actuales:"),
    );
    expect(out.indexOf("- Ramas por defecto:")).toBeLessThan(out.indexOf("- Ramas QA actuales:"));
  });

  it("does not leak defaults into working_branches / qa_branches", () => {
    const out = renderHubBlock({
      ...BASE,
      defaultBranches: { principal: "main", desarrollo: "development", qa: "qa" },
      workingBranches: { core: "feature/x" },
      qaBranches: { core: "desarrollo" },
    });
    const parsed = parseHubBlock(out);
    expect(parsed?.working_branches).toEqual({ core: "feature/x" });
    expect(parsed?.qa_branches).toEqual({ core: "desarrollo" });
  });

  it("parses the entry into default_branches and ignores unknown roles", () => {
    const out = renderHubBlock({
      ...BASE,
      defaultBranches: { principal: "main", qa: "qa" },
    }).replace("  - qa: qa", "  - qa: qa\n  - inventado: nope");
    const parsed = parseHubBlock(out);
    expect(parsed?.default_branches).toEqual({ principal: "main", qa: "qa" });
  });

  it("defaults to an empty object when no entry is present", () => {
    expect(parseHubBlock(renderHubBlock(BASE))?.default_branches).toEqual({});
  });

  it("round-trips through blockFromParsed", () => {
    const first = renderHubBlock({
      ...BASE,
      defaultBranches: { principal: "main", desarrollo: "development", qa: "qa" },
      workingBranches: { core: "feature/x" },
    });
    const parsed = parseHubBlock(first);
    if (!parsed) throw new Error("expected parsed block");
    const second = blockFromParsed(parsed);
    expect(second).toBe(first);
    expect(parseHubBlock(second)?.default_branches).toEqual({
      principal: "main",
      desarrollo: "development",
      qa: "qa",
    });
  });

  it("a block without defaults re-renders identical (no phantom entry)", () => {
    const first = renderHubBlock({ ...BASE, workingBranches: { core: "feature/x" } });
    const parsed = parseHubBlock(first);
    if (!parsed) throw new Error("expected parsed block");
    expect(blockFromParsed(parsed)).toBe(first);
  });
});

describe("project-block main_branch (nullable)", () => {
  it("parses a populated legacy cell as-is", () => {
    const parsed = parseHubBlock(renderHubBlock(BASE));
    expect(parsed?.fuentes[0]?.main_branch).toBe("certificacion");
  });

  it("parses an empty cell as null instead of the legacy 'certificacion' literal", () => {
    const out = renderHubBlock({
      ...BASE,
      fuentes: [{ alias: "core", path: "/p", main_branch: null }],
    });
    expect(out).toContain("| core | /p |  |");
    expect(parseHubBlock(out)?.fuentes[0]?.main_branch).toBeNull();
  });

  it("round-trips a null main_branch", () => {
    const first = renderHubBlock({
      ...BASE,
      fuentes: [{ alias: "core", path: "/p", main_branch: null }],
    });
    const parsed = parseHubBlock(first);
    if (!parsed) throw new Error("expected parsed block");
    expect(blockFromParsed(parsed)).toBe(first);
  });
});

describe("aw hub-block --init --default-*-branch", () => {
  let cwd: string;
  let ctx: CliContext;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "aw-hub-block-defaults-"));
    const paths = new PathsService(normalizeNamespace("agent-workflow"), cwd, cwd);
    const block = renderHubBlock({
      ...BASE,
      fuentes: [{ alias: "core", path: "core", main_branch: null }],
      defaultBranches: { principal: "main", desarrollo: "development", qa: "qa" },
      markers: paths.blockMarkers(),
    });
    await writeFile(join(cwd, "AGENTS.md"), block, "utf8");
    ctx = { fs: new NodeFileSystem(), env: new FakeEnv(cwd, cwd), paths } as unknown as CliContext;
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  function init(values: Record<string, string>): ParsedArgs {
    return {
      rest: [],
      plugin: {},
      flags: new Set(["--init"]),
      values: new Map(Object.entries(values)),
      valuesMulti: new Map(),
    };
  }

  async function written() {
    const text = await readFile(join(cwd, "AGENTS.md"), "utf8");
    const parsed = parseHubBlock(text, ctx.paths.blockMarkers());
    if (!parsed) throw new Error("expected a hub block");
    return parsed;
  }

  it.each([
    ["default-main-branch", { principal: "prod", desarrollo: "development", qa: "qa" }],
    ["default-dev-branch", { principal: "main", desarrollo: "prod", qa: "qa" }],
    ["default-qa-branch", { principal: "main", desarrollo: "development", qa: "prod" }],
  ])("--%s escribe solo su rol y conserva los demás", async (flag, expected) => {
    const result = await hubBlockUpsertCommand.execute(init({ [flag]: "prod" }), ctx);
    expect(result.ok).toBe(true);
    expect((await written()).default_branches).toEqual(expected);
  });

  it("las tres juntas escriben los tres roles", async () => {
    const result = await hubBlockUpsertCommand.execute(
      init({
        "default-main-branch": "certificacion",
        "default-dev-branch": "desarrollo",
        "default-qa-branch": "calidad",
      }),
      ctx,
    );
    expect(result.ok).toBe(true);
    expect((await written()).default_branches).toEqual({
      principal: "certificacion",
      desarrollo: "desarrollo",
      qa: "calidad",
    });
  });

  it("--main-branch sin --fuente no escribe ningún rol ni la celda de la fuente", async () => {
    const result = await hubBlockUpsertCommand.execute(init({ "main-branch": "otra" }), ctx);
    expect(result.ok).toBe(true);
    const parsed = await written();
    expect(parsed.default_branches).toEqual({
      principal: "main",
      desarrollo: "development",
      qa: "qa",
    });
    expect(parsed.fuentes[0]?.main_branch).toBeNull();
  });
});
