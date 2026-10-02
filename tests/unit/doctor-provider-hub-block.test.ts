import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { applyDoctorBatch } from "../../src/application/doctor/apply.js";
import { prepareDoctorBatch } from "../../src/application/doctor/prepare.js";
import {
  applyRetiredSectionRemoval,
  hubBlockProvider,
} from "../../src/application/doctor/provider-hub-block.js";
import { runDoctor } from "../../src/application/doctor/report.js";
import { PathsService } from "../../src/application/paths-service.js";
import type { HostStateReport } from "../../src/application/self/host-states.js";
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
  return `# Manual\n\n${markers.start}\n## Hub\n\nEjemplo\n\n## Fuentes\n\n_Sin fuentes._\n\n## Stack\n\nTypeScript\n\n## Status\n\n${markers.end}\n`;
}

it("informa el CLAUDE.md heredado, ya no la divergencia, y sólo marca secciones que citan identidades retiradas", async () => {
  const claude = join(root, "CLAUDE.md");
  const agents = join(root, "AGENTS.md");
  await fs.writeText(
    claude,
    `${block()}\n## Reglas transversales qtc-*\n\nUsa agent-workflow:rules y qtc:graduacion-routing.\n\n## Skill de plugin vigente\n\nUsa qtc:actual.\n`,
  );
  await fs.writeText(agents, block().replace("Ejemplo", "Nombre distinto"));
  const report = await runDoctor(ctx, {}, { providers: [hubBlockProvider] });
  const findings = report.findings.filter((finding) => finding.category === "hub-visibility");
  expect(findings.map((finding) => finding.id).sort()).toEqual([
    "hub/hub-visibility/CLAUDE.md:secciones-retiradas",
    "hub/hub-visibility/claude-md-heredado",
  ]);
  expect(findings.some((finding) => finding.summary.includes("divergen"))).toBe(false);
  const retired = findings.find((finding) => finding.id.endsWith("secciones-retiradas"));
  expect(retired?.remediation.action?.op).toBe("hub.remove-retired-section");
  expect(retired?.evidence).toContain("Reglas transversales qtc-*: agent-workflow:rules");
  const legacy = findings.find((finding) => finding.id.endsWith("claude-md-heredado"));
  expect(legacy?.remediation.guidance).toContain("aw hub-migrate --apply");
});

it("prepare y apply quitan la sección retired fuera del marcador y dejan todo lo demás igual", async () => {
  const text = `${block()}\n## Reglas transversales qtc-*\n\nUsa agent-workflow:rules.\n\n## Guía del equipo\n\nNo borrar esto.\n`;
  const claude = join(root, "CLAUDE.md");
  await fs.writeText(claude, text);
  await fs.writeText(join(root, "AGENTS.md"), block());
  const deps = { providers: [hubBlockProvider] };
  const report = await runDoctor(ctx, {}, deps);
  const id = report.findings.find((finding) =>
    finding.id.endsWith("CLAUDE.md:secciones-retiradas"),
  )?.id;
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
  const report = await runDoctor(ctx, {}, { providers: [hubBlockProvider] });
  const findings = report.findings.filter((finding) => finding.category === "hub-visibility");
  const retired = findings.filter((finding) => finding.id.endsWith("secciones-retiradas"));
  expect(retired).toHaveLength(2);
  expect(retired[0]?.evidence).toContain("Referencias antiguas: /w:comando-eliminado");
  expect(await applyRetiredSectionRemoval(fs, path, ctx.paths.blockMarkers())).toBe(true);
  expect(await readFile(path, "utf8")).toBe(
    before.replace("## Referencias antiguas\n\nUsa /w:comando-eliminado.\n\n", ""),
  );
});

// ─── 30.0.0: AGENTS.md es el único archivo del bloque ────────────────────────

function claudeState(version: string): HostStateReport {
  return { host: "claude-code", runtime: { version } } as unknown as HostStateReport;
}

async function hubFindings(hubDir: string, states: HostStateReport[] = []) {
  const output = await hubBlockProvider.run({
    ctx,
    hosts: [],
    hostStates: states,
    currentHost: null,
    hubDir,
    skipNative: true,
  });
  return output.findings.map((finding) => finding.id);
}

it("un CLAUDE.md sin @AGENTS.md en una carpeta superior tapa el AGENTS.md del hub", async () => {
  const hubDir = join(root, "proyectos", "hub");
  await fs.mkdirp(hubDir);
  await fs.writeText(join(hubDir, "AGENTS.md"), block());
  expect(await hubFindings(hubDir)).toEqual([]);

  await fs.writeText(join(root, "proyectos", "CLAUDE.md"), "# Reglas de la carpeta\n");
  const output = await hubBlockProvider.run({
    ctx,
    hosts: [],
    hostStates: [],
    currentHost: null,
    hubDir,
    skipNative: true,
  });
  const shadow = output.findings.find((finding) => finding.id.endsWith("agents-md-tapado"));
  expect(shadow?.evidence).toEqual([`${join(root, "proyectos", "CLAUDE.md")} existe`]);
  expect(shadow?.remediation.guidance[0]).toContain("@AGENTS.md");

  // Un CLAUDE.md del hub que importa AGENTS.md lo vuelve a traer.
  await fs.writeText(join(hubDir, "CLAUDE.md"), "@AGENTS.md\n");
  expect(await hubFindings(hubDir)).toEqual([]);
});

it("un CLAUDE.local.md también tapa, y ~/.claude/CLAUDE.md no cuenta", async () => {
  const hubDir = join(root, "hub");
  await fs.mkdirp(join(root, ".claude"));
  await fs.mkdirp(hubDir);
  await fs.writeText(join(hubDir, "AGENTS.md"), block());
  await fs.writeText(join(root, ".claude", "CLAUDE.md"), "# Preferencias personales\n");
  expect(await hubFindings(hubDir)).toEqual([]);

  await fs.writeText(join(hubDir, "CLAUDE.local.md"), "# Notas locales\n");
  expect(await hubFindings(hubDir)).toEqual(["hub/hub-visibility/agents-md-tapado"]);
});

it("el CLAUDE.md heredado del hub se reporta una vez, como migración pendiente", async () => {
  await fs.writeText(join(root, "AGENTS.md"), block());
  await fs.writeText(join(root, "CLAUDE.md"), block());
  expect(await hubFindings(root)).toEqual(["hub/hub-visibility/claude-md-heredado"]);
});

it("Claude Code anterior a 2.1.277 no lee AGENTS.md; desde 2.1.277 no se avisa", async () => {
  await fs.writeText(join(root, "AGENTS.md"), block());
  expect(await hubFindings(root, [claudeState("2.1.276 (Claude Code)")])).toEqual([
    "claude-code/hub-visibility/claude-sin-agents-md",
  ]);
  expect(await hubFindings(root, [claudeState("2.1.277 (Claude Code)")])).toEqual([]);
  expect(await hubFindings(root, [claudeState("sin versión")])).toEqual([]);
});
