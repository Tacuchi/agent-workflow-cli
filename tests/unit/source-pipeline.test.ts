import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { parseHubBlock } from "../../src/application/parsers/hub-block.js";
import { PathsService } from "../../src/application/paths-service.js";
import { renderHubBlock } from "../../src/application/render/hub-block.js";
import { readSourcePipelines, sourcePipeline } from "../../src/application/source-pipeline.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";

const fs = new NodeFileSystem();
let cwd: string;
afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

it("el lector distingue comando, ninguno y no declarado con acción y origen del espejo", async () => {
  cwd = await mkdtemp(join(tmpdir(), "aw-pipeline-reader-"));
  const paths = new PathsService(normalizeNamespace("workflow"), cwd, cwd);
  const block = renderHubBlock({
    proyecto: "Demo",
    stack: {},
    fuentes: [
      { alias: "core", path: "/repo", main_branch: "main" },
      { alias: "docs", path: "/docs", main_branch: "main" },
    ],
    pipeline: { core: { build: "npm run build", test: "npm test" }, docs: { build: "ninguno" } },
  });
  await fs.writeText(join(cwd, "AGENTS.md"), block);
  const pipelines = await readSourcePipelines(fs, paths);
  expect(pipelines).toEqual([
    {
      alias: "core",
      build: { kind: "command", command: "npm run build" },
      test: { kind: "command", command: "npm test" },
      origin: "AGENTS.md",
    },
    {
      alias: "docs",
      build: { kind: "none", value: "ninguno" },
      test: { kind: "undeclared", action: "aw set-pipeline docs test <comando|ninguno>" },
      origin: "AGENTS.md",
    },
  ]);
  const parsed = parseHubBlock(block);
  if (parsed === null) throw new Error("expected a parsed block");
  expect(sourcePipeline(parsed, "core").build).toEqual({
    kind: "command",
    command: "npm run build",
  });
});
