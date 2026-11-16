import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { MaterializingHubFileSystem } from "../../src/application/hub-materialization-service.js";
import { McpHostReceiptService } from "../../src/application/mcp-host-receipt-service.js";
import { NodeMcpHostReceiptStore } from "../../src/application/mcp-host-receipt-store.js";
import { PathsService } from "../../src/application/paths-service.js";
import { migrateRetiredNames } from "../../src/application/retired-name-migration.js";
import { computeNoteDigest, validateDecisionNote } from "../../src/domain/decision-note.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { MemFs } from "../helpers/mem-fs.js";

const paths = new PathsService(normalizeNamespace("workflow"), "/home/u", "/hub");
const oldMarker = "/hub/.workflow/workline.json";
const newMarker = "/hub/.workflow/agent-workflow.json";
const block =
  "<!-- WORKFLOW-HUB-START -->\n## Hub\n\nEjemplo\n\n## Workline\n\n- Estado: `aw status`.\n<!-- WORKFLOW-HUB-END -->\n";

it("reads retired MCP receipts without writing and rewrites their key once on update", async () => {
  const base = await mkdtemp(join(tmpdir(), "aw-receipt-migration-"));
  const file = join(base, "receipts.json");
  const identity = { host: "codex" as const, scope: "global" as const, connection: "example" };
  const receipt = {
    schema_version: 1,
    ...identity,
    workline_version: "31.1.1",
    descriptor_digest: `sha256:${"1".repeat(64)}`,
    registered_at: "2026-11-16T00:00:00.000Z",
    reload_required: true,
  };
  const original = JSON.stringify({ schema_version: 1, receipts: [receipt] });
  await writeFile(file, original);
  const service = new McpHostReceiptService(new NodeMcpHostReceiptStore(file));
  expect((await service.list())[0]?.agent_workflow_version).toBe("31.1.1");
  expect(await readFile(file, "utf8")).toBe(original);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    await service.recordLaunchProbe({ ...identity, outcome: "passed", phase: "spawn" });
    expect(await readFile(file, "utf8")).not.toContain("workline_version");
    expect(stderr).toHaveBeenCalledTimes(1);
    await service.recordLaunchProbe({ ...identity, outcome: "passed", phase: "spawn" });
    expect(stderr).toHaveBeenCalledTimes(1);
  } finally {
    stderr.mockRestore();
  }
});

it("migrates on the actual first hub write and preserves namespace, model and valid note seals", async () => {
  const fs = new MemFs()
    .file(oldMarker, '{"workline":1,"namespace":"workflow","model":"documents"}')
    .file("/hub/AGENTS.md", block);
  const body = {
    schema: "workline.decision-note/v1",
    id: "DEC-001",
    lineage: {
      spec: {
        path: "docs/specs/001-spec-example.md",
        number: "001",
        digest: `sha256:${"1".repeat(64)}`,
      },
      plan: {
        path: "docs/plans/001-plan-example.md",
        number: "001",
        digest: `sha256:${"2".repeat(64)}`,
      },
      execution: { session: "example", phase: "F1" },
    },
    decision: "Conservar el contrato",
    reason: "Los consumidores lo requieren",
    supersedes_assertions: ["S001/AC-01"],
    supersedes_note: null,
    scope: "plan-only" as const,
    consumers: ["cli"],
    evidence_preserved: ["suite"],
    evidence_invalidated: [],
    obligations: [],
    resume_point: "continuar",
    date: "2026-11-16",
  };
  const oldNote = { ...body, digest: computeNoteDigest(body) };
  expect(validateDecisionNote(oldNote).ok).toBe(true);
  fs.file("/hub/docs/decisions/example.json", JSON.stringify(oldNote));
  fs.file(
    "/hub/docs/decisions/index.json",
    JSON.stringify({ schema: "workline.decision-index/v1", spec: "001", notes: [oldNote] }),
  );
  const guarded = new MaterializingHubFileSystem(fs, paths);
  await guarded.writeText("/hub/docs/reports/example.md", "nuevo");
  expect(await fs.exists(oldMarker)).toBe(false);
  expect(JSON.parse(await fs.readText(newMarker))).toEqual({
    agent_workflow: 1,
    namespace: "workflow",
    model: "documents",
  });
  expect(await fs.readText("/hub/AGENTS.md")).toContain("## agent-workflow");
  const migrated = JSON.parse(await fs.readText("/hub/docs/decisions/example.json"));
  expect(migrated.schema).toBe("agent-workflow.decision-note/v1");
  expect(migrated.digest).not.toBe(oldNote.digest);
  expect(validateDecisionNote(migrated).ok).toBe(true);
  expect(JSON.parse(await fs.readText("/hub/docs/decisions/index.json")).schema).toBe(
    "agent-workflow.decision-index/v1",
  );
  const index = JSON.parse(await fs.readText("/hub/docs/decisions/index.json"));
  expect(index.notes[0].schema).toBe("agent-workflow.decision-note/v1");
  expect(validateDecisionNote(index.notes[0]).ok).toBe(true);
  fs.writes.clear();
  await migrateRetiredNames(fs, paths);
  expect(fs.writes.size).toBe(0);
});

it("keeps conflicting old markers and removes only equivalent duplicates", async () => {
  const fs = new MemFs()
    .file(oldMarker, '{"workline":1,"model":"sessions"}')
    .file(newMarker, '{"agent_workflow":1,"model":"documents"}');
  await migrateRetiredNames(fs, paths);
  expect(await fs.readText(oldMarker)).toContain("sessions");
  expect(await fs.readText(newMarker)).toContain("documents");
  fs.file(oldMarker, '{"model":"documents","workline":1}');
  await migrateRetiredNames(fs, paths);
  expect(await fs.exists(oldMarker)).toBe(false);
});

async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const item of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (item.isFile()) {
      const path = join(item.parentPath, item.name);
      result[path.slice(root.length)] = await readFile(path, "utf8");
    }
  }
  return result;
}

it("keeps all four CLI reads byte-identical, warns, then migrates explicitly once", async () => {
  const base = await mkdtemp(join(tmpdir(), "aw-name-migration-"));
  const root = join(base, "hub");
  const home = join(base, "home");
  await mkdir(join(root, ".workflow"), { recursive: true });
  await mkdir(home);
  await mkdir(join(root, "docs/plans"), { recursive: true });
  await writeFile(
    join(root, ".workflow/workline.json"),
    '{"workline":1,"namespace":"workflow","model":"documents"}\n',
  );
  await writeFile(join(root, "AGENTS.md"), block);
  await writeFile(
    join(root, "docs/plans/001-plan-example.md"),
    "# Plan 001 — example\n\n> Standalone: example\n> Estado: ready\n> Límite de ejecución: checkout\n",
  );
  const run = (args: string[]) =>
    spawnSync(process.execPath, [resolve("dist/cli/main.js"), ...args, "--format", "json"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, HOME: home, AW_NAMESPACE: "workflow" },
    });
  const before = await snapshot(root);
  for (const args of [
    ["status"],
    ["resume"],
    ["doctor"],
    ["flow", "read", "--flow", "plan-exec", "--doc", "docs/plans/001-plan-example.md"],
  ]) {
    const read = run(args);
    if (args[0] === "doctor") {
      expect(read.status, read.stdout + read.stderr).toBe(1);
      expect(JSON.parse(read.stdout).hosts).toEqual([]);
      expect(
        JSON.parse(read.stdout).findings.some((f: { id: string }) =>
          f.id.endsWith("retired-heading"),
        ),
      ).toBe(true);
    } else expect(read.status, read.stdout + read.stderr).toBe(0);
    expect(read.stderr).toContain("aw hub-migrate");
    expect(await snapshot(root)).toEqual(before);
  }
  const first = run(["hub-migrate", "--apply"]);
  expect(first.status, first.stdout + first.stderr).toBe(0);
  expect(first.stderr).toContain("Migrado");
  const migrated = await snapshot(root);
  expect(migrated["/.workflow/agent-workflow.json"]).toContain('"agent_workflow": 1');
  expect(migrated["/.workflow/workline.json"]).toBeUndefined();
  const second = run(["hub-migrate", "--apply"]);
  expect(second.status, second.stdout + second.stderr).toBe(0);
  expect(second.stderr).not.toContain("Migrado");
  expect(await snapshot(root)).toEqual(migrated);
}, 60000);
