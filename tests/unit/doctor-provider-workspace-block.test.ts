import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { applyDoctorBatch } from "../../src/application/doctor/apply.js";
import { prepareDoctorBatch } from "../../src/application/doctor/prepare.js";
import {
  applyRetiredSectionRemoval,
  workspaceBlockProvider,
} from "../../src/application/doctor/provider-workspace-block.js";
import { runDoctor } from "../../src/application/doctor/report.js";
import { PathsService } from "../../src/application/paths-service.js";
import type { CliContext } from "../../src/cli/types.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { FakeProcess } from "../helpers/fake-process.js";

let root: string;
let ctx: CliContext;
const fs = new NodeFileSystem();

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "aw-doctor-block-"));
  ctx = {
    fs,
    env: new FakeEnv(root, root),
    process: new FakeProcess(),
    paths: new PathsService(normalizeNamespace("agent-workflow"), root, root),
  } as CliContext;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function block(): string {
  const markers = ctx.paths.blockMarkers();
  return `# Manual\n\n${markers.start}\n## Proyecto\n\nEjemplo\n\n## Fuentes\n\n_Sin fuentes._\n\n## Stack\n\nTypeScript\n\n## Status\n\n${markers.end}\n`;
}

it("informa divergencia del par y sólo marca secciones que citan identidades retiradas", async () => {
  const claude = join(root, "CLAUDE.md");
  const agents = join(root, "AGENTS.md");
  await fs.writeText(
    claude,
    `${block()}\n## Reglas transversales qtc-*\n\nUsa agent-workflow:rules y qtc:graduacion-routing.\n\n## Skill de plugin vigente\n\nUsa qtc:actual.\n`,
  );
  await fs.writeText(agents, block().replace("Ejemplo", "Nombre distinto"));
  const report = await runDoctor(ctx, {}, { providers: [workspaceBlockProvider] });
  expect(report.findings.map((finding) => finding.summary)).toEqual([
    expect.stringContaining("CLAUDE.md cita"),
    expect.stringContaining("divergen"),
  ]);
  expect(report.findings[0]?.remediation.action?.op).toBe("workspace.remove-retired-section");
  expect(report.findings[0]?.evidence).toContain(
    "Reglas transversales qtc-*: agent-workflow:rules",
  );
});

it("prepare y apply quitan la sección retired fuera del marcador y dejan todo lo demás igual", async () => {
  const text = `${block()}\n## Reglas transversales qtc-*\n\nUsa agent-workflow:rules.\n\n## Guía del equipo\n\nNo borrar esto.\n`;
  const claude = join(root, "CLAUDE.md");
  await fs.writeText(claude, text);
  await fs.writeText(join(root, "AGENTS.md"), block());
  const deps = { providers: [workspaceBlockProvider] };
  const report = await runDoctor(ctx, {}, deps);
  const id = report.findings.find((finding) => finding.resource.name === "CLAUDE.md")?.id;
  if (id === undefined) throw new Error("no se encontró la sección retired");
  const prepared = await prepareDoctorBatch(ctx, { select: [id] }, deps);
  if (!prepared.ok || prepared.kind !== "sealed") throw new Error("prepare no selló el lote");
  expect(prepared.proposal.read_set.map((item) => item.id)).toContain(claude);
  const applied = await applyDoctorBatch(
    ctx,
    { select: [id], approval: prepared.proposal.digest },
    deps,
  );
  if (!applied.ok) throw new Error(applied.rejection.message);
  expect(applied.result.actions[0]?.status).toBe("applied");
  expect(await readFile(claude, "utf8")).toBe(
    text.replace("## Reglas transversales qtc-*\n\nUsa agent-workflow:rules.\n\n", ""),
  );
});

it("también detecta una sección ajena dentro del bloque sin borrar secciones del CLI ni skills de plugins", async () => {
  const before = block().replace(
    "## Status\n\n",
    "## Referencias antiguas\n\nUsa /w:comando-eliminado.\n\n## Status\n\n",
  );
  const path = join(root, "CLAUDE.md");
  await fs.writeText(path, before);
  await fs.writeText(join(root, "AGENTS.md"), before);
  const report = await runDoctor(ctx, {}, { providers: [workspaceBlockProvider] });
  expect(report.findings).toHaveLength(2);
  expect(report.findings[0]?.evidence).toContain("Referencias antiguas: /w:comando-eliminado");
  expect(await applyRetiredSectionRemoval(fs, path, ctx.paths.blockMarkers())).toBe(true);
  expect(await readFile(path, "utf8")).toBe(
    before.replace("## Referencias antiguas\n\nUsa /w:comando-eliminado.\n\n", ""),
  );
});
