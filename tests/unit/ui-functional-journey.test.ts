import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { functionalSpecDigest } from "../../src/application/parsers/spec-functional.js";
import { parsePlanBaselineSeal } from "../../src/application/parsers/spec-relation.js";
import { PathsService } from "../../src/application/paths-service.js";
import { resolveSkills } from "../../src/application/skills-resolver-service.js";
import { DOCS_BOUNDARY, journeyOfFlow } from "../../src/domain/flow/authority.js";
import { alignSpecBaseline, specBaselineDigest } from "../../src/domain/lineage.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";

const SPEC_PATH = "docs/specs/001-spec-ui.md";

function spec(origin: string): string {
  return `---
status: ready-for-plan
---
# Spec 001 — recorrido accesible

## Requirement
El formulario ofrece mensajes de error accesibles sin perder los valores ingresados.

## Scope
Pantalla de alta de miembro.

## Acceptance criteria
- [ ] AC-01: si falla el envío, el foco pasa al resumen de errores y los valores permanecen.

## Scenarios
GIVEN datos inválidos WHEN se envía THEN el foco anuncia los errores sin borrar campos.

## Decisions
- Mostrar un resumen con foco y conservar los datos; motivo: evitar que la persona repita su entrada. Fuente: ${origin}.
`;
}

describe("SPEC → PLAN → QUICK con ayuda UI opcional", () => {
  it.each([false, true])(
    "%s: una oferta ambiental no añade un gate ni acredita el plan",
    async (help) => {
      const root = await mkdtemp(join(tmpdir(), "aw-ui-functional-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        await mkdir(home);
        await mkdir(workspace);
        if (help) {
          const skill = join(home, ".agents/skills/ui-authoring");
          await mkdir(skill, { recursive: true });
          await writeFile(
            join(skill, "SKILL.md"),
            "---\nname: ui-authoring\n---\nPropuesta de resumen accesible.\n",
          );
        }
        const paths = new PathsService(normalizeNamespace("agent-workflow"), home, workspace);
        const bindings = await resolveSkills(new NodeFileSystem(), paths);
        expect(bindings.skills).toEqual({
          overview: { role: "overview", skill: "w", source: "default", enabled: true },
        });

        const authored = spec(help ? "ayuda ambiental revisada" : "elección de la persona");
        expect(authored).toContain("## Decisions\n- Mostrar un resumen con foco");
        const digest = functionalSpecDigest(authored);
        const plan = `# Plan 001 — UI\n> Baseline: ${SPEC_PATH}@${digest}\n\n## Tasks\n- [ ] F1: implementar errores accesibles.\n`;
        expect(
          alignSpecBaseline(parsePlanBaselineSeal(plan), {
            functional: digest,
            exact: specBaselineDigest(authored),
          }),
        ).toEqual({ status: "aligned", digest });
        // QUICK has no docs/ destination; both it and the plan consume functional
        // input through ordinary gates, independently of which host helped write it.
        expect(DOCS_BOUNDARY["spec-refine"]).toEqual(["docs/specs"]);
        expect(DOCS_BOUNDARY["plan-exec"]).toEqual(["docs/plans"]);
        expect(DOCS_BOUNDARY.quick).toEqual([]);
        for (const flow of ["spec-refine", "plan-new", "plan-exec", "quick"] as const) {
          const transitions = journeyOfFlow(flow).map((step) => step.id);
          expect(transitions.some((id) => id.includes("design"))).toBe(false);
          expect(transitions).toContain("chassis.route-evaluation");
        }
        expect(journeyOfFlow("quick").map((step) => step.id)).toContain(
          "quick.commit-authorization",
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
