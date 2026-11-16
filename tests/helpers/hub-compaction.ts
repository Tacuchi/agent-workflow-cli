import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NodeArchive } from "../../src/adapters/node-archive.js";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import type { CompactionDeps } from "../../src/application/hub-compaction/inventory.js";
import { inventoryHub } from "../../src/application/hub-compaction/inventory.js";
import { prepareCompaction } from "../../src/application/hub-compaction/proposal.js";
import { PathsService } from "../../src/application/paths-service.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "./fake-env.js";

/** A closed plan of `docs/`: the history `hub-compact` may archive (spec 066, AC-14). */
export const ORIGINAL = "docs/plans/001-plan-history.md";
/** A protected document: the live plan. */
export const PLAN = "docs/plans/002-plan-vivo.md";
/** A live document that is never eligible. */
export const LIVE = PLAN;

export async function compactionFixture() {
  const root = await mkdtemp(join(tmpdir(), "aw-compaction-"));
  const fs = new NodeFileSystem();
  const paths = new PathsService(normalizeNamespace("workflow"), root, root);
  const deps: CompactionDeps = {
    fs,
    paths,
    archive: new NodeArchive(),
    env: new FakeEnv(root, root),
  };
  const write = async (path: string, content: string | Uint8Array) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  };
  await write(".workflow/agent-workflow.json", '{"agent_workflow":1}\n');
  await write(
    ORIGINAL,
    `# Plan 001 — history\n> Standalone: fixture\n> Estado: done\n\n## Tasks\n- [x] T1 — hecho\n\n${"historical evidence\n".repeat(2000)}`,
  );
  await write(
    LIVE,
    "# Plan 002 — vivo\n> Standalone: fixture\n> Estado: ready\n\n## Tasks\n- [ ] T1\n",
  );
  return { root, deps, write, cleanup: () => rm(root, { recursive: true, force: true }) };
}

export async function snapshot(root: string, path = ""): Promise<Record<string, string>> {
  const output: Record<string, string> = {};
  for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
    const rel = path ? `${path}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(output, await snapshot(root, rel));
    else if (entry.isSymbolicLink()) output[rel] = "symlink";
    else output[rel] = (await readFile(join(root, rel))).toString("base64");
  }
  return output;
}

export async function prepareFixture(
  fixture: Awaited<ReturnType<typeof compactionFixture>>,
  selection = [ORIGINAL],
) {
  const inventory = await inventoryHub(fixture.deps);
  return prepareCompaction(fixture.deps, {
    version: 1,
    inventory_fingerprint: inventory.fingerprint,
    selection,
    claims: [
      {
        topic: "History",
        kind: "fact",
        text: "Historical evidence remains recoverable",
        references: [PLAN],
      },
    ],
  });
}
