import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { parseProjectBlock } from "../../src/application/parsers/project-block.js";
import { PathsService } from "../../src/application/paths-service.js";
import { runProjectMdUpsertWrite } from "../../src/application/project-md-upsert-service.js";
import { blockFromParsed } from "../../src/application/render/project-block.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";

describe("pipeline versionado en el bloque", () => {
  const fs = new NodeFileSystem();
  let cwd: string;
  afterEach(async () => {
    if (cwd) await rm(cwd, { recursive: true, force: true });
  });

  async function setup() {
    cwd = await mkdtemp(join(tmpdir(), "aw-pipeline-"));
    const paths = new PathsService(normalizeNamespace("workflow"), cwd, cwd);
    const env = new FakeEnv(cwd);
    await runProjectMdUpsertWrite(fs, env, paths, {
      op: "init",
      lastActivity: "2026-01-01",
      fuentes: [
        { alias: "core", path: "/repo/core" },
        { alias: "plugin", path: "/repo/plugin" },
      ],
      pipeline: {
        core: { build: "npm run build", test: "npm test" },
        plugin: { build: "npm run build", test: "npm test" },
      },
    });
    return { paths, env };
  }

  it("lee y conserva dos líneas distintas con comandos idénticos, también tras la deduplicación legacy", async () => {
    const { paths, env } = await setup();
    for (const file of ["CLAUDE.md", "AGENTS.md"]) {
      const text = await readFile(join(cwd, file), "utf8");
      const oldCliPreserved = [...new Set(text.split("\n"))].join("\n");
      expect(oldCliPreserved).toContain("- core: build `npm run build` · test `npm test`");
      expect(oldCliPreserved).toContain("- plugin: build `npm run build` · test `npm test`");
      expect(parseProjectBlock(oldCliPreserved)?.pipeline.plugin?.test).toBe("npm test");
    }
    await runProjectMdUpsertWrite(fs, env, paths, { op: "init", lastActivity: "2026-01-01" });
    for (const file of ["CLAUDE.md", "AGENTS.md"]) {
      const text = await readFile(join(cwd, file), "utf8");
      expect(text.match(/## Pipeline/g)).toHaveLength(1);
      expect(text).toContain("- plugin: build `npm run build` · test `npm test`");
      const parsed = parseProjectBlock(text);
      if (parsed === null) throw new Error("expected a parsed block");
      expect(blockFromParsed(parsed)).toBe(text.trimEnd());
    }
  });

  it("conserva notas sueltas y poda registros de fuentes reemplazadas o eliminadas", async () => {
    const { paths, env } = await setup();
    const agents = join(cwd, "AGENTS.md");
    await fs.writeText(
      agents,
      (await readFile(agents, "utf8")).replace(
        "- plugin: build",
        "Nota: revisar Jenkins\n- plugin: build",
      ),
    );
    const replaced = await runProjectMdUpsertWrite(fs, env, paths, {
      op: "init",
      fuentes: [{ alias: "core", path: "/repo/core" }],
      replaceFuentes: true,
      lastActivity: "2026-01-01",
    });
    expect("error" in replaced).toBe(false);
    if ("error" in replaced) return;
    expect(replaced.dropped_lines).toContain("- plugin: build `npm run build` · test `npm test`");
    for (const file of ["CLAUDE.md", "AGENTS.md"]) {
      const text = await readFile(join(cwd, file), "utf8");
      expect(text).not.toContain("- plugin: build");
      expect(text).toContain("Nota: revisar Jenkins");
    }
    const removed = await runProjectMdUpsertWrite(fs, env, paths, {
      op: "init",
      removeAliases: ["core"],
      lastActivity: "2026-01-01",
    });
    expect("error" in removed).toBe(false);
    if ("error" in removed) return;
    expect(removed.dropped_lines).toContain("- core: build `npm run build` · test `npm test`");
    expect(await readFile(join(cwd, "CLAUDE.md"), "utf8")).not.toContain("- core: build");
  });
});
