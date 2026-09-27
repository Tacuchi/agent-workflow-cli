import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { advanceFlow } from "../../src/application/flow/flow-service.js";
import { locateRun, readRun } from "../../src/application/flow/run-state-service.js";
import { submitFlow } from "../../src/application/flow/submit.js";
import { PathsService } from "../../src/application/paths-service.js";
import { parseFlowAnswer } from "../../src/domain/flow/answer.js";
import type { FlowDecision } from "../../src/domain/flow/authority.js";
import { attemptAccountingAt } from "../../src/domain/flow/run-state.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { NodeFileSystem } from "../helpers/real-fs.js";

const invocation = { program: "aw", args: ["status", "--json"], target: ".", input: null };
const transition = "fixture.ejecutar";

vi.mock("../../src/domain/flow/authority.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/domain/flow/authority.js")>();
  const journey: FlowDecision[] = [
    {
      id: "fixture.ejecutar",
      scope: "quick",
      title: "ejecutar sobre el checkout",
      authority: "cli",
      ownership: "cli-owned",
      document: "loops/quick-loop/LOOP.md",
      effects: ["read_only"],
      action: {
        invocation: { program: "aw", args: ["status", "--json"], target: ".", input: null },
        execution: { kind: "external", reason: "la corre el host" },
        evidence: ["fixture.proof"],
        idempotent: true,
        recovery: "corregí el resultado y volvé a ejecutar",
      },
    },
  ];
  return {
    ...real,
    journeyOfFlow: (flow: string) =>
      flow === "quick"
        ? journey
        : real.journeyOfFlow(flow as Parameters<typeof real.journeyOfFlow>[0]),
  };
});

describe("submit informa juntas las violaciones independientes del sobre", () => {
  const fs = new NodeFileSystem();
  let root: string;
  let paths: PathsService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "aw-flow-violations-"));
    paths = new PathsService(normalizeNamespace("agent-workflow"), root, root);
    await mkdir(join(paths.cwdSessionsDir(), "001-sobre-quick"), { recursive: true });
    await writeFile(
      join(paths.cwdSessionsDir(), "001-sobre-quick", "SESSION.md"),
      "# SESSION\n\n## Objective\nvalidar\n",
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("passed como texto, commit y un kind inexistente llegan juntos sin gastar", async () => {
    const adopted = await advanceFlow(fs, paths, { code: "001", flow: "quick", adopt: true });
    if (!adopted.ok) throw new Error("la corrida no se adoptó");
    const refused = await submitFlow(fs, paths, {
      code: "001",
      approval: null,
      raw: JSON.stringify({
        input_digest: adopted.directive.state_digest,
        outcome: "completed",
        invocation,
        validations: [
          {
            id: "fixture.proof",
            passed: "true",
            detail: "la salida real",
            proof: { kind: "otro", source: "workspace", relative_cwd: ".", checkout_digest: "abc" },
          },
        ],
        effects: { planned: ["read_only"], approved: [], applied: ["commit"] },
      }),
    });
    if (!refused.ok) throw new Error("el rechazo debe viajar dentro de la directiva");
    expect(refused.directive.error?.code).toBe("FLOW_RESULT_INVALID");
    expect(refused.directive.error?.violations?.map((item) => item.field)).toEqual([
      "validations[0].passed",
      "validations[0].proof.kind",
      "effects.applied",
    ]);
    expect(refused.directive.error?.violations?.map((item) => item.expected)).toEqual([
      "boolean",
      "command | inspection",
      "{planned: EffectClass[], approved: EffectClass[], applied: EffectClass[]}",
    ]);
    expect(refused.directive.error?.violations?.[2]?.message).toContain("commit");
    expect(refused.directive.error?.violations?.[2]?.message).toContain("destructive");
    const read = await readRun(fs, locateRun(paths, "001-sobre-quick"));
    if (!read.ok) throw new Error("el estado quedó ilegible");
    expect(attemptAccountingAt(read.state, transition).spent).toBe(0);
    expect(refused.directive.boundary.transition).toBe(transition);
  });

  it("admite target equivalente y proof null; sólo infiere applied ausente en completed", () => {
    const decision: FlowDecision = {
      id: "fixture.ejecutar",
      scope: "quick",
      title: "ejecutar",
      authority: "cli",
      ownership: "cli-owned",
      document: "loops/quick-loop/LOOP.md",
      effects: ["read_only"],
    };
    const action = {
      invocation,
      execution: { kind: "external" as const, reason: "el host" },
      evidence: ["fixture.proof"],
      idempotent: true,
      recovery: "reintentá",
    };
    const parse = (applied?: string[]) =>
      parseFlowAnswer({
        raw: JSON.stringify({
          input_digest: "sello",
          outcome: "completed",
          invocation: { ...invocation, target: process.cwd() },
          validations: [{ id: "fixture.proof", passed: true, detail: "ok", proof: null }],
          effects: { planned: ["read_only"], approved: [], ...(applied ? { applied } : {}) },
        }),
        boundary: "execution",
        decision,
        action,
        seal: "sello",
        choices: [],
        approval: null,
        expectedApproval: null,
      });
    const inferred = parse();
    expect(inferred.ok).toBe(true);
    if (!inferred.ok) throw new Error(inferred.failure.message);
    expect(inferred.answer.result?.effects.applied).toEqual(["read_only"]);
    expect(inferred.answer.result?.validations[0]?.proof).toBeUndefined();
    const explicit = parse([]);
    if (!explicit.ok) throw new Error(explicit.failure.message);
    expect(explicit.answer.result?.effects.applied).toEqual([]);
  });
});
