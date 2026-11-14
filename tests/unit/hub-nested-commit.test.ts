// Spec 067, AC-04 (F2): un hub anidado dentro de un repositorio mayor propone y
// commitea sus entregables con rutas relativas al hub, muestra la ruta Git y
// rechaza la forma con prefijo nombrando la esperada. Repo git temporal y el
// binario construido.

import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DocFlowHub, dataOf, docFlowHub } from "../helpers/doc-flow-hub.js";

const PLAN = "docs/plans/001-plan-ejemplo.md";
const PREFIX = "projects/ejemplo/";

describe("commit del hub anidado con rutas relativas al hub", () => {
  let hub: DocFlowHub;
  const hubArgs = (...paths: string[]) => [
    "--source",
    "hub",
    "--message",
    "docs: plan 001",
    ...paths.flatMap((path) => ["--path", path]),
  ];
  const codeOf = (json: Record<string, unknown>) => (json.error as { code: string }).code;

  beforeEach(() => {
    hub = docFlowHub({ nested: "projects/ejemplo" });
    writeFileSync(join(hub.root, PLAN), "# Plan 001 — ejemplo\n");
    // Un cambio ajeno del repositorio mayor, fuera del hub.
    writeFileSync(join(hub.root, "..", "..", "README.md"), "otro proyecto\n");
  });
  afterEach(() => hub.dispose());

  it("propone y commitea docs/... y deja fuera los cambios ajenos", () => {
    const proposed = hub.aw(["flow", "propose-commit", ...hubArgs(PLAN)]);
    expect(proposed.status, JSON.stringify(proposed.json)).toBe(0);
    const proposal = dataOf(proposed.json);
    expect(proposal).toMatchObject({
      source: "hub",
      checkout: realpathSync(hub.root),
      paths: [expect.objectContaining({ path: PLAN, git_path: `${PREFIX}${PLAN}` })],
    });

    const committed = hub.aw([
      "flow",
      "commit",
      ...hubArgs(PLAN),
      "--approval",
      proposal.approval as string,
    ]);
    expect(committed.status, JSON.stringify(committed.json)).toBe(0);
    expect(hub.git("show", "--name-only", "--format=", "HEAD").trim()).toBe(`${PREFIX}${PLAN}`);
    // porcelain spells paths from the repository root, not from the hub.
    expect(hub.git("status", "--porcelain", "--", "../../README.md").trim()).toBe("?? README.md");
  });

  it("la aprobación sella los bytes del archivo dentro del hub anidado", () => {
    const proposal = dataOf(hub.aw(["flow", "propose-commit", ...hubArgs(PLAN)]).json);
    writeFileSync(join(hub.root, PLAN), "# Plan 001 — ejemplo cambiado\n");
    const stale = hub.aw([
      "flow",
      "commit",
      ...hubArgs(PLAN),
      "--approval",
      proposal.approval as string,
    ]);
    expect(codeOf(stale.json)).toBe("COMMIT_PROPOSAL_STALE");
  });

  it("rechaza la ruta con el prefijo nombrando la forma esperada", () => {
    const prefixed = hub.aw(["flow", "propose-commit", ...hubArgs(`${PREFIX}${PLAN}`)]);
    expect(codeOf(prefixed.json)).toBe("HUB_PATH_PREFIXED");
    expect((prefixed.json.error as { message: string }).message).toContain(`se espera '${PLAN}'`);
    expect(dataOf(prefixed.json).action).toContain(`'${PLAN}'`);

    // El límite de entregables sigue en pie.
    writeFileSync(join(hub.root, "notas.md"), "x\n");
    const outside = hub.aw(["flow", "propose-commit", ...hubArgs("notas.md")]);
    expect(codeOf(outside.json)).toBe("DELIVERABLE_OUTSIDE_DOCS");
  });
});
