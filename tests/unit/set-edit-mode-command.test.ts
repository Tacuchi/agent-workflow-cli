import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { readHubBlock } from "../../src/application/parsers/hub-block.js";
import { PathsService } from "../../src/application/paths-service.js";
import { setEditModeCommand } from "../../src/cli/commands/set-edit-mode.js";
import type { CliContext } from "../../src/cli/types.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";

let root: string;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
it("declara el modo sin reemplazar las fuentes y lo cambia de nuevo", async () => {
  root = await mkdtemp(join(tmpdir(), "aw-set-edit-mode-"));
  const fs = new NodeFileSystem();
  const paths = new PathsService(normalizeNamespace("workflow"), root, root);
  const ctx = { fs, paths, env: new FakeEnv(root) } as unknown as CliContext;
  const args = (mode: string) => ({
    rest: [mode],
    plugin: {},
    flags: new Set<string>(),
    values: new Map(),
    valuesMulti: new Map(),
  });
  expect((await setEditModeCommand.execute(args("in-place"), ctx)).ok).toBe(true);
  expect((await readHubBlock(fs, root, paths.blockMarkers()))?.edit_mode).toBe("in-place");
  expect((await setEditModeCommand.execute(args("unit"), ctx)).ok).toBe(true);
  expect((await readHubBlock(fs, root, paths.blockMarkers()))?.edit_mode).toBe("unit");
  expect(await readFile(join(root, "CLAUDE.md"), "utf8")).toContain("- Modo de edición: unit");
  expect((await setEditModeCommand.execute(args("bad"), ctx)).ok).toBe(false);
});
