import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { advanceFlow } from "../../src/application/flow/flow-service.js";
import { locateRun, readRun } from "../../src/application/flow/run-state-service.js";
import { checkFlow, submitFlow } from "../../src/application/flow/submit.js";
import { PathsService } from "../../src/application/paths-service.js";
import { flowCommand } from "../../src/cli/commands/flow.js";
import { parseArgv } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
import type { FlowDecision } from "../../src/domain/flow/authority.js";
import { FLOW_RUN_STATE_FILE, attemptAccountingAt } from "../../src/domain/flow/run-state.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { NodeFileSystem } from "../helpers/real-fs.js";

let stdin = "";
vi.mock("../../src/cli/context-id.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/cli/context-id.js")>();
  return { ...original, readRequiredStdin: async () => stdin };
});

vi.mock("../../src/domain/flow/authority.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/domain/flow/authority.js")>();
  const journey: FlowDecision[] = [
    {
      id: "fixture.ejecutar",
      scope: "quick",
      title: "verificar el sobre",
      authority: "cli",
      ownership: "cli-owned",
      document: "loops/quick-loop/LOOP.md",
      effects: ["read_only"],
      action: {
        invocation: { program: "aw", args: ["status", "--json"], target: ".", input: null },
        execution: { kind: "external", reason: "el host ejecuta la acción" },
        evidence: ["fixture.resultado"],
        idempotent: true,
        recovery: "reintentá",
      },
    },
  ];
  return { ...original, journeyOfFlow: () => journey };
});

describe("aw flow submit --check", () => {
  const fs = new NodeFileSystem();
  let root: string;
  let paths: PathsService;
  let seal: string;
  const executor = vi.fn(async () => ({ ok: true, summary: "", output: "", effects: [] }));
  const statePath = () => join(paths.cwdSessionsDir(), "001-sobre-quick", FLOW_RUN_STATE_FILE);
  const result = (valid: boolean) =>
    JSON.stringify({
      input_digest: seal,
      outcome: "completed",
      invocation: { program: "aw", args: ["status", "--json"], target: ".", input: null },
      validations: [
        { id: "fixture.resultado", passed: valid ? true : "true", detail: "salida real" },
      ],
      effects: { planned: ["read_only"], approved: [], applied: ["read_only"] },
    });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "aw-flow-check-"));
    paths = new PathsService(normalizeNamespace("agent-workflow"), root, root);
    await mkdir(join(paths.cwdSessionsDir(), "001-sobre-quick"), { recursive: true });
    await writeFile(
      join(paths.cwdSessionsDir(), "001-sobre-quick", "SESSION.md"),
      "# SESSION\n\n## Objective\nprobar\n",
    );
    const adopted = await advanceFlow(fs, paths, { code: "001", flow: "quick", adopt: true });
    if (!adopted.ok) throw new Error("la corrida no se adoptó");
    seal = adopted.directive.state_digest;
    executor.mockClear();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("el sobre inválido devuelve la misma violación sin cambiar bytes ni intento", async () => {
    const raw = result(false);
    const before = await readFile(statePath());
    const checked = await checkFlow(fs, paths, { code: "001", raw, approval: null, executor });
    if (!checked.ok) throw new Error("check rechazó la corrida");
    expect(checked.receipt.valid).toBe(false);
    expect(checked.receipt.violations.map((item) => item.field)).toEqual(["validations[0].passed"]);
    expect(await readFile(statePath())).toEqual(before);
    expect(executor).not.toHaveBeenCalled();
    const submitted = await submitFlow(fs, paths, { code: "001", raw, approval: null, executor });
    if (!submitted.ok) throw new Error("submit rechazó la corrida");
    expect(submitted.directive.error?.violations).toEqual(checked.receipt.violations);
    const read = await readRun(fs, locateRun(paths, "001-sobre-quick"));
    if (!read.ok) throw new Error("el estado quedó ilegible");
    expect(attemptAccountingAt(read.state, "fixture.ejecutar").spent).toBe(0);
  });

  it("el sobre válido devuelve cero violaciones sin ejecutar ni avanzar", async () => {
    const before = await readFile(statePath());
    const checked = await checkFlow(fs, paths, {
      code: "001",
      raw: result(true),
      approval: null,
      executor,
    });
    if (!checked.ok) throw new Error("check rechazó la corrida");
    expect(checked.receipt).toMatchObject({ check: true, valid: true, violations: [] });
    expect(await readFile(statePath())).toEqual(before);
    expect(executor).not.toHaveBeenCalled();
  });

  it("argv trata --check como booleano sin consumir el argumento siguiente y llega al despacho", async () => {
    stdin = result(false);
    const args = parseArgv(["flow", "submit", "--session", "001", "--check", "siguiente"]);
    expect(args.flags.has("--check")).toBe(true);
    expect(args.rest).toEqual(["submit", "siguiente"]);
    const before = await readFile(statePath());
    const ctx = {
      fs,
      paths,
      env: new FakeEnv(root, root),
      git: undefined,
      runtime: undefined,
    } as unknown as CliContext;
    const response = await flowCommand.execute(args, ctx);
    expect(response.ok).toBe(true);
    expect(response.data).toMatchObject({ check: true, valid: false });
    expect(await readFile(statePath())).toEqual(before);
  });
});
