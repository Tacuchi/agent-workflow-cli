// Spec 066, AC-17 a AC-19 (F7): un hub del modelo de sesiones migra con un
// commit, conserva specs, planes, números y relaciones, la persona confirma cada
// plan dudoso y cada sesión activa, y el CLI rechaza el hub mientras no migra.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DocFlowHub, dataOf, docFlowHub } from "../helpers/doc-flow-hub.js";

const SPEC = "docs/specs/003-spec-cupones.md";

const plan = (number: string, state: string, boxes: string[]) =>
  [
    `# Plan ${number} — cupones`,
    "",
    `> Derived from ${SPEC}`,
    state,
    "",
    "## Tasks",
    "",
    ...boxes.map((box, index) => `- [${box}] T1.${index + 1} — paso ${index + 1}`),
    "",
  ].join("\n");

const PLANS: Record<string, string> = {
  "docs/plans/010-plan-cerrado.md": plan("010", "> Estado: done", ["x", "x"]),
  "docs/plans/011-plan-con-sufijo.md": plan("011", "> Estado: done — 2026-07-27 · sesión 123", [
    "x",
  ]),
  "docs/plans/012-plan-sin-avance.md": plan("012", "> Estado: open", [" ", " "]),
  "docs/plans/013-plan-con-avance.md": plan("013", "> Estado: open", ["x", " "]),
  "docs/plans/014-plan-contradictorio.md": plan("014", "> Estado: open", ["x", "x"]),
};

describe("aw hub-migrate --documents", () => {
  let hub: DocFlowHub;
  beforeEach(() => {
    hub = docFlowHub();
    writeFileSync(
      join(hub.root, SPEC),
      "---\nstatus: ready-for-plan\n---\n\n# Spec 003 — Cupones\n",
    );
    for (const [path, text] of Object.entries(PLANS)) writeFileSync(join(hub.root, path), text);
    const sessions = join(hub.root, ".workflow/sessions");
    mkdirSync(join(sessions, "281-modo-global-plan-exec"), { recursive: true });
    writeFileSync(join(sessions, "281-modo-global-plan-exec/SESSION.md"), "# SESSION\n");
    mkdirSync(join(sessions, "200-viejo-quick"), { recursive: true });
    writeFileSync(join(sessions, "200-viejo-quick/SESSION.md"), "# SESSION\n");
    writeFileSync(join(sessions, "200-viejo-quick/.closed"), "");
    writeFileSync(join(hub.root, ".workflow/HISTORY.md"), "| 200 | viejo |\n");
    writeFileSync(join(hub.root, ".workflow/claims.jsonl"), "{}\n");
    hub.checkpoint("hub del modelo de sesiones");
  });
  afterEach(() => hub.dispose());

  const preview = () => dataOf(hub.aw(["hub-migrate", "--documents"]).json);

  it("rechaza el hub sin migrar con la instrucción de migrarlo; la migración y la ayuda responden", () => {
    const status = hub.aw(["status"]);
    expect(status.status).toBe(1);
    expect((status.json.error as { code: string }).code).toBe("HUB_MIGRATION_REQUIRED");
    expect(JSON.stringify(status.json)).toContain("aw hub-migrate --documents");
    expect(hub.aw(["hub-migrate", "--documents"]).status).toBe(0);
    expect(hub.aw(["status", "--help"]).status).toBe(0);
  });

  it("escenario «plan de estado contradictorio al migrar»: lo muestra antes del commit y espera la respuesta", () => {
    const view = preview();
    const byFile = new Map(
      (view.plans as { file: string; to: string | null; kind: string }[]).map((p) => [p.file, p]),
    );
    expect(byFile.get("docs/plans/010-plan-cerrado.md")).toMatchObject({
      to: "done",
      kind: "unchanged",
    });
    expect(byFile.get("docs/plans/011-plan-con-sufijo.md")).toMatchObject({
      to: "done",
      kind: "deduced",
    });
    expect(byFile.get("docs/plans/012-plan-sin-avance.md")).toMatchObject({
      to: "ready",
      kind: "deduced",
    });
    expect(byFile.get("docs/plans/013-plan-con-avance.md")).toMatchObject({
      to: "in-progress",
      kind: "deduced",
    });
    expect(byFile.get("docs/plans/014-plan-contradictorio.md")).toMatchObject({
      to: null,
      kind: "needs-answer",
    });
    expect(view.active_sessions).toEqual(["281-modo-global-plan-exec"]);
    expect(hub.changed()).toEqual([]);

    // Sin respuesta para el plan dudoso ni para la sesión activa, no escribe nada.
    const refused = hub.aw(
      ["hub-migrate", "--documents", "--apply", "--approval", view.digest as string],
      "{}",
    );
    expect(refused.status).toBe(1);
    expect((refused.json.error as { code: string }).code).toBe("HUB_MIGRATION_ANSWER_REQUIRED");
    expect(JSON.stringify(refused.json)).toContain("014-plan-contradictorio.md");
    expect(JSON.stringify(refused.json)).toContain("281-modo-global-plan-exec");
    expect(hub.changed()).toEqual([]);
  });

  it("migra con un commit y conserva specs, planes, números y relaciones", () => {
    const specBefore = readFileSync(join(hub.root, SPEC), "utf8");
    const view = preview();
    const answers = JSON.stringify({
      plans: { "docs/plans/014-plan-contradictorio.md": "done" },
      sessions: { "281-modo-global-plan-exec": "abandon" },
    });
    const applied = hub.aw(
      ["hub-migrate", "--documents", "--apply", "--approval", view.digest as string],
      answers,
    );
    expect(applied.status, JSON.stringify(applied.json)).toBe(0);

    const read = (path: string) => readFileSync(join(hub.root, path), "utf8");
    expect(read("docs/plans/010-plan-cerrado.md")).toContain("> Estado: done");
    expect(read("docs/plans/011-plan-con-sufijo.md")).toMatch(
      /> Estado: done\n> Cierre: 2026-07-27/,
    );
    expect(read("docs/plans/012-plan-sin-avance.md")).toContain("> Estado: ready");
    expect(read("docs/plans/013-plan-con-avance.md")).toContain(
      "> Estado: in-progress\n> Próximo paso: T1.2 — paso 2",
    );
    expect(read("docs/plans/014-plan-contradictorio.md")).toContain("> Estado: done");
    for (const path of Object.keys(PLANS)) {
      expect(existsSync(join(hub.root, path)), path).toBe(true);
      expect(read(path)).toContain(`> Derived from ${SPEC}`);
    }
    expect(read(SPEC)).toBe(specBefore);
    for (const gone of [".workflow/sessions", ".workflow/HISTORY.md", ".workflow/claims.jsonl"]) {
      expect(existsSync(join(hub.root, gone)), gone).toBe(false);
    }
    expect(JSON.parse(read(".workflow/agent-workflow.json"))).toMatchObject({ model: "documents" });

    // Un único commit, aprobado por su digest.
    const commit = dataOf(applied.json).commit as { approval: string; paths: { path: string }[] };
    const touched = commit.paths.map((entry) => entry.path);
    expect(touched).not.toContain(SPEC);
    expect(
      touched.every((path) => path.startsWith("docs/plans/") || path.startsWith(".workflow/")),
    ).toBe(true);
    const before = hub.git("rev-list", "--count", "HEAD").trim();
    const done = hub.aw(["hub-migrate", "--documents", "--commit", "--approval", commit.approval]);
    expect(done.status, JSON.stringify(done.json)).toBe(0);
    expect(Number(hub.git("rev-list", "--count", "HEAD").trim())).toBe(Number(before) + 1);
    expect(hub.changed()).toEqual([]);

    // El hub migrado pasa `aw status` con 31.0.0.
    const status = hub.aw(["status", "--detail"]);
    expect(status.status, JSON.stringify(status.json)).toBe(0);
    const plans = dataOf(status.json).plans as { number: string; declared_state: string }[];
    expect(plans.map((p) => [p.number, p.declared_state])).toEqual([
      ["010", "done"],
      ["011", "done"],
      ["012", "ready"],
      ["013", "in-progress"],
      ["014", "done"],
    ]);
  });
});
