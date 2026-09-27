import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { PathsService } from "../../src/application/paths-service.js";
import {
  preparationMismatch,
  recordPreparation,
} from "../../src/application/preparation-receipts.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { worklineMarkerContent } from "../../src/runtime/workline-marker.js";
import { NodeFileSystem } from "../helpers/real-fs.js";

let root: string | null = null;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = null;
});

it("un recibo de preparación nombra la raíz ajena sin autorizar el apply ahí", async () => {
  root = await mkdtemp(join(tmpdir(), "aw-seal-"));
  const home = join(root, "home");
  const hubA = join(root, "hub-a");
  const hubB = join(root, "hub-b");
  await Promise.all([home, hubA, hubB].map((path) => mkdir(path)));
  const fs = new NodeFileSystem();
  const namespace = normalizeNamespace("workflow");
  const a = new PathsService(namespace, home, hubA);
  const b = new PathsService(namespace, home, hubB);
  await recordPreparation(fs, a, "persist", "sello-aprobado");
  expect(await preparationMismatch(a, "persist", "sello-aprobado")).toBeNull();
  expect(await preparationMismatch(b, "persist", "sello-aprobado")).toContain(
    `preparado en ${hubA}; workspace actual ${hubB}`,
  );
  expect(await preparationMismatch(b, "persist", "sello-desconocido")).toBeNull();
});

it("persist validado en A no aplica en B aun si ambos tienen docs idénticos", async () => {
  root = await mkdtemp(join(tmpdir(), "aw-persist-roots-"));
  const base = root;
  const home = join(root, "home");
  const hubA = join(root, "hub-a");
  const hubB = join(root, "hub-b");
  await mkdir(home);
  for (const hub of [hubA, hubB]) {
    await mkdir(join(hub, ".workflow", "sessions"), { recursive: true });
    await writeFile(join(hub, ".workflow", "workline.json"), worklineMarkerContent("workflow"));
  }
  const cli = fileURLToPath(new URL("../../dist/cli/main.js", import.meta.url));
  const run = (hub: string, stage: string, input?: string, approval?: string) => {
    const args = [cli, "persist", stage, "--workspace", hub, "--json"];
    if (approval) args.push("--approval", approval);
    const output = spawnSync(process.execPath, args, {
      cwd: base,
      env: { ...process.env, HOME: home, AW_NAMESPACE: "workflow" },
      encoding: "utf8",
      input,
    });
    return { status: output.status, body: JSON.parse(output.stdout) as Record<string, unknown> };
  };
  const prepared = run(hubA, "prepare");
  expect(prepared.status).toBe(0);
  const request = prepared.body.request as { input_digest: string };
  const answer = JSON.stringify({
    version: 1,
    operation: "persist",
    input_digest: request.input_digest,
    state: "proposed",
    decisions: { category: "research", slug: "prueba", mode: "new" },
    artifacts: [
      { path: "docs/research/001-research-prueba.md", content: "# Prueba\n\ncontenido\n" },
    ],
  });
  const validated = run(hubA, "validate", answer);
  expect(validated.status).toBe(0);
  const refusal = run(hubB, "apply", answer, validated.body.approval_digest as string);
  expect(refusal.status).not.toBe(0);
  expect(JSON.stringify(refusal.body)).toContain("WORKSPACE_MISMATCH");
  expect(JSON.stringify(refusal.body)).toContain(hubA);
  expect(JSON.stringify(refusal.body)).toContain(hubB);
  await expect(
    new NodeFileSystem().exists(join(hubB, "docs", "research", "001-research-prueba.md")),
  ).resolves.toBe(false);
});
