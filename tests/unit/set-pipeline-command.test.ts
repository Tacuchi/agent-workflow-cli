import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { runHubBlockUpsertWrite } from "../../src/application/hub-block-upsert-service.js";
import { PathsService } from "../../src/application/paths-service.js";
import { setPipelineCommand } from "../../src/cli/commands/set-pipeline.js";
import type { ParsedArgs } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";

const fs = new NodeFileSystem();
let cwd: string;
afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

function args(rest: string[]): ParsedArgs {
  return { rest, flags: new Set(), values: new Map(), valuesMulti: new Map(), plugin: {} };
}

it("declara build y test, ninguno explícito, en los dos espejos y rechaza alias ajenos", async () => {
  cwd = await mkdtemp(join(tmpdir(), "aw-set-pipeline-"));
  const paths = new PathsService(normalizeNamespace("workflow"), cwd, cwd);
  const env = new FakeEnv(cwd);
  const ctx = { fs, env, paths } as unknown as CliContext;
  await runHubBlockUpsertWrite(fs, env, paths, {
    op: "init",
    fuentes: [{ alias: "core", path: "../repo" }],
  });
  expect(
    (await setPipelineCommand.execute(args(["other", "build", "ninguno"]), ctx)).error?.code,
  ).toBe("SOURCE_UNKNOWN");
  expect((await setPipelineCommand.execute(args(["core", "build", "ninguno"]), ctx)).ok).toBe(true);
  expect((await setPipelineCommand.execute(args(["core", "test", "npm test"]), ctx)).ok).toBe(true);
  for (const file of ["CLAUDE.md", "AGENTS.md"]) {
    expect(await readFile(join(cwd, file), "utf8")).toContain(
      "- core: build ninguno · test `npm test`",
    );
  }
});
