import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { PathsService } from "../../src/application/paths-service.js";
import { runSessionCreate } from "../../src/application/session-create-service.js";
import { FLOW_SUCCESS_CRITERIA } from "../../src/domain/flow/success-criteria.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";

/**
 * A documentary run is born with its Success criteria written (plan 082 F7 ·
 * spec 061 AC-09): the flow's fixed checklist plus the acceptance criteria of
 * the spec it rests on. Any other flow keeps the one blank item.
 */

const SPEC = "docs/specs/031-spec-correo.md";
const PLAN = "docs/plans/031-plan-correo.md";
const SPEC_TEXT = `---
status: ready-for-plan
---
# Spec 031 — correo

## Acceptance criteria

- [ ] AC-01: el correo llega en menos de un minuto.
- [ ] AC-02: un correo rebotado se reintenta una vez.

## Open questions

- [ ] AC-09: esto es una pregunta, no un criterio.
`;

let hub: string;
let paths: PathsService;
const fs = new NodeFileSystem();

beforeEach(() => {
  hub = mkdtempSync(join(tmpdir(), "aw-criteria-seed-"));
  paths = new PathsService(normalizeNamespace("workflow"), hub, hub);
  mkdirSync(join(hub, "docs", "specs"), { recursive: true });
  mkdirSync(join(hub, "docs", "plans"), { recursive: true });
  writeFileSync(join(hub, SPEC), SPEC_TEXT);
  writeFileSync(join(hub, PLAN), `# Plan 031 — correo\n\n> Derived from ${SPEC}\n> Estado: open\n`);
});

afterEach(() => rmSync(hub, { recursive: true, force: true }));

async function criteriaOf(type: string, name: string): Promise<string[]> {
  const result = await runSessionCreate(fs, paths, { type, name, objetivo: "o" });
  if ("error" in result) throw new Error(result.error);
  const text = readFileSync(result.sessionCreate.session_path, "utf8");
  const section = text.split("## Success criteria")[1] ?? "";
  return [...section.matchAll(/^- \[ \] ?(.*)$/gm)].map((match) => match[1] as string);
}

const ACS = [
  "AC-01: el correo llega en menos de un minuto.",
  "AC-02: un correo rebotado se reintenta una vez.",
];

describe("the documentary flows start with their criteria seeded", () => {
  it("spec-refine: its checklist, then the ACs of the spec it refines", async () => {
    expect(await criteriaOf("refine", "correo-spec-refine")).toEqual([
      ...(FLOW_SUCCESS_CRITERIA["spec-refine"] ?? []),
      ...ACS,
    ]);
  });

  it("plan-new: its checklist, then the ACs of the spec it plans", async () => {
    expect(await criteriaOf("refine", "correo-plan-new")).toEqual([
      ...(FLOW_SUCCESS_CRITERIA["plan-new"] ?? []),
      ...ACS,
    ]);
  });

  it("plan-refine: its checklist, then the ACs of the spec its plan derives from", async () => {
    expect(await criteriaOf("refine", "correo-plan-refine")).toEqual([
      ...(FLOW_SUCCESS_CRITERIA["plan-refine"] ?? []),
      ...ACS,
    ]);
  });

  it("only the Acceptance criteria section counts, never a labelled line elsewhere", async () => {
    const seeded = await criteriaOf("refine", "correo-plan-new");
    expect(seeded.some((line) => line.startsWith("AC-09"))).toBe(false);
  });
});

describe("the other flows keep the blank item for their own authoring", () => {
  it("plan-exec closes on the plan's phases and quick authors its own", async () => {
    expect(await criteriaOf("exec", "correo-plan-exec")).toEqual([""]);
    expect(await criteriaOf("quick", "correo-quick")).toEqual([""]);
  });
});
