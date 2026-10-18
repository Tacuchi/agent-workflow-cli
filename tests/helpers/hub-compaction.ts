import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NodeArchive } from "../../src/adapters/node-archive.js";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import type { CompactionDeps } from "../../src/application/hub-compaction/inventory.js";
import { inventoryHub } from "../../src/application/hub-compaction/inventory.js";
import { prepareCompaction } from "../../src/application/hub-compaction/proposal.js";
import { PathsService } from "../../src/application/paths-service.js";
import { preservedBaseline, sealCustody } from "../../src/domain/session/custody.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "./fake-env.js";

export const SESSION = ".workflow/sessions/001-history-plan-exec";
export const ORIGINAL = `${SESSION}/evidence/trace.log`;
export const PLAN = "docs/plans/001-plan-history.md";

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
  const plan = "# Plan 001 — history\n> Standalone: fixture\n> Estado: done\n\n## Tasks\n";
  await write(PLAN, plan);
  await write(`${SESSION}/SESSION.md`, "# Session\n\n## Objective\nPreserve evidence\n");
  await write(`${SESSION}/.closed`, "");
  await write(
    `${SESSION}/.custody.json`,
    JSON.stringify(
      sealCustody({
        subject: { kind: "session", key: "001-history-plan-exec" },
        subjectPath: join(root, SESSION),
        parents: [{ kind: "plan", key: "001" }],
        created: "2026-10-18",
        artifacts: [{ path: PLAN, role: "input", before: preservedBaseline(plan) }],
      }),
    ),
  );
  await write(ORIGINAL, "historical evidence\n".repeat(2000));
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
