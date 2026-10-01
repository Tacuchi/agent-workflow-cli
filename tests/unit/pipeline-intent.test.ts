import { describe, expect, it } from "vitest";
import { PathsService } from "../../src/application/paths-service.js";
import { runResume } from "../../src/application/resume-service.js";
import { runStatusCommand } from "../../src/application/status-service.js";
import { buildWorklineIndex } from "../../src/application/workline-index-service.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { MemFs } from "../helpers/mem-fs.js";

const env = new FakeEnv("/home", "/cwd");
const NOW = new Date(2026, 8, 14, 12, 0, 0);
const CLI = "agent-workflow-cli";

function paths(): PathsService {
  return new PathsService(normalizeNamespace("workflow"), "/home", "/cwd");
}

function index(fs: MemFs) {
  return buildWorklineIndex(fs, env, paths(), { now: NOW });
}

function plan(fs: MemFs, number: string, slug: string): void {
  fs.file(
    `/cwd/docs/plans/${number}-plan-${slug}.md`,
    [
      `# Plan ${number}`,
      "",
      "> Derived from docs/specs/090-spec-corte.md",
      "> Estado: open",
      "> Límite de ejecución: checkout",
      "",
      "## Tasks",
      "",
      "### F1 — un estado",
      "",
      "> Estado: pendiente",
      "> Fuentes: agent-workflow-cli",
      "",
      "- [ ] T1.1 — algo _(fuentes: agent-workflow-cli)_",
      "",
    ].join("\n"),
  );
}

/** A cut of three plans, all born from one spec, none of them started. */
function hub(): MemFs {
  const fs = new MemFs();
  fs.file("/cwd/.workflow/sessions/.keep", "");
  fs.file("/cwd/docs/specs/090-spec-corte.md", "---\nstatus: ready-for-plan\n---\n\n# Spec 090\n");
  plan(fs, "091", "uno");
  plan(fs, "092", "dos");
  plan(fs, "093", "tres");
  return fs;
}

/** The order somebody declared: 092 first, then 091, with 093 held for later. */
function declareCut(fs: MemFs): void {
  fs.file(
    "/cwd/.workflow/cut-intents.jsonl",
    `${JSON.stringify({
      version: 1,
      at: "2026-09-14T10:00:00.000Z",
      event: "declared",
      intent: {
        spec: { kind: "spec", key: "090" },
        order: [
          { kind: "plan", key: "092" },
          { kind: "plan", key: "091" },
        ],
        deferred: [{ kind: "plan", key: "093" }],
      },
    })}\n`,
  );
}

function passes(fs: MemFs, arrived: boolean): void {
  const lines = [
    JSON.stringify({
      version: 1,
      at: "2026-09-14T11:00:00.000Z",
      event: "declared",
      pass: {
        version: "v1.0.0",
        plans: [
          { kind: "plan", key: "091" },
          { kind: "plan", key: "092" },
        ],
        sources: [CLI],
      },
    }),
  ];
  if (arrived) {
    lines.push(
      JSON.stringify({
        version: 1,
        at: "2026-09-14T12:00:00.000Z",
        event: "arrived",
        pass_version: "v1.0.0",
        arrival: { source: CLI, kind: "published-version", detail: "1.0.0", at: "2026-09-14" },
      }),
    );
  }
  fs.file("/cwd/.workflow/release-passes.jsonl", `${lines.join("\n")}\n`);
}

/**
 * The recommendation, once somebody can say what they meant.
 *
 * Until now the only order the board could offer was the correlative — an
 * accident of when a document was minted, presented as a decision. These are the
 * three things that change, and the one that must NOT.
 */
describe("el tablero obedece la intención declarada y lo ya liberado", () => {
  it("sin intención ni pases declarados, el orden es exactamente el de hoy", async () => {
    const out = await index(hub());
    const plans = out.pipeline.filter((item) => item.number !== null && item.kind === "plan-open");

    // The correlative, untouched: this is the assertion that keeps the change
    // from reordering a board nobody declared anything about.
    expect(plans.map((item) => item.number)).toEqual(["091", "092", "093"]);
    expect(plans.every((item) => item.intent === undefined)).toBe(true);
    expect(plans.every((item) => item.detail.postponed === undefined)).toBe(true);
  });

  it("la intención invierte el correlativo y la propuesta encabeza por intención", async () => {
    const fs = hub();
    declareCut(fs);
    passes(fs, false);

    const out = await index(fs);
    const plans = out.pipeline.filter((item) => item.kind === "plan-open");

    // 092 before 091 although 091 is the lower correlative, and 093 last because
    // it was reserved for a later pass.
    expect(plans.map((item) => item.number)).toEqual(["092", "091", "093"]);
    expect(plans[0]?.intent).toEqual({ placement: "in-pass", index: 0 });
    expect(plans[1]?.intent).toEqual({ placement: "in-pass", index: 1 });
  });

  it("el reservado aparece postergado con su motivo mientras el pase anterior sigue abierto", async () => {
    const fs = hub();
    declareCut(fs);
    passes(fs, false);

    const out = await index(fs);
    const held = out.pipeline.find((item) => item.number === "093");

    expect(held?.detail.postponed?.waiting_on).toEqual(["plan:092", "plan:091"]);
    expect(held?.detail.postponed?.reason).toContain("v1.0.0");
    expect(held?.detail.postponed?.reason).toContain("pase posterior");
    // Postponed is not blocked: the row keeps its command and stays runnable.
    expect(held?.action.kind).toBe("continue");
    expect(held?.command).not.toBeNull();
  });

  it("al cerrar el pase, lo liberado sale del tablero y el reservado se vuelve recomendable", async () => {
    const fs = hub();
    declareCut(fs);
    passes(fs, true);

    const out = await index(fs);
    const plans = out.pipeline.filter((item) => item.kind === "plan-open");

    // 091 and 092 shipped, so they are no longer pending work — a second axis
    // beside closure, which had them open.
    expect(plans.map((item) => item.number)).toEqual(["093"]);
    expect(plans[0]?.detail.postponed).toBeUndefined();
    const shipped = out.plans.filter((p) => p.number !== "093");
    expect(shipped.every((p) => p.plan_state === "open")).toBe(true);
    expect(shipped.every((p) => p.production.axis === "in-production")).toBe(true);
  });

  it("el plan liberado no aparece entre los candidatos de la reanudación", async () => {
    const fs = hub();
    declareCut(fs);
    passes(fs, true);

    const out = await runResume(fs, env, paths(), { now: NOW });

    expect(out.status).toBe("proposal");
    if (out.status !== "proposal") return;
    const numbers = (out.candidates ?? []).map((candidate) => candidate.number);
    expect(numbers).not.toContain("091");
    expect(numbers).not.toContain("092");
    expect(out.proposal.number).toBe("093");
  });

  it("la reanudación sigue siendo un relevo: proyecta el pipeline, no vuelve a decidir", async () => {
    const fs = hub();
    declareCut(fs);
    passes(fs, false);

    const out = await runResume(fs, env, paths(), { now: NOW });
    const board = await index(fs);

    expect(out.status).toBe("proposal");
    if (out.status !== "proposal") return;
    // Same order, same head, same command — the CLI decided once and resume read
    // it. A second derivation here is exactly how the two surfaces could disagree.
    expect((out.candidates ?? []).map((c) => c.number)).toEqual(
      board.pipeline.map((item) => item.number),
    );
    expect(out.proposal.number).toBe(board.pipeline[0]?.number);
    expect(out.proposal.command).toBe(board.pipeline[0]?.command);
  });

  it("no se posterga para siempre por un plan que el workspace no tiene", async () => {
    const fs = hub();
    // The cut puts 093 behind a plan that was discarded — or never written. It
    // has no pass and it never will, so waiting on it is waiting forever.
    fs.file(
      "/cwd/.workflow/cut-intents.jsonl",
      `${JSON.stringify({
        version: 1,
        at: "2026-09-14T10:00:00.000Z",
        event: "declared",
        intent: {
          spec: { kind: "spec", key: "090" },
          order: [{ kind: "plan", key: "777" }],
          deferred: [{ kind: "plan", key: "093" }],
        },
      })}\n`,
    );

    const out = await index(fs);
    const held = out.pipeline.find((item) => item.number === "093");

    expect(held).toBeDefined();
    expect(held?.detail.postponed).toBeUndefined();
  });

  it("con algo real por delante, nombra lo que falta y lo que el workspace no tiene", async () => {
    const fs = hub();
    fs.file(
      "/cwd/.workflow/cut-intents.jsonl",
      `${JSON.stringify({
        version: 1,
        at: "2026-09-14T10:00:00.000Z",
        event: "declared",
        intent: {
          spec: { kind: "spec", key: "090" },
          order: [
            { kind: "plan", key: "091" },
            { kind: "plan", key: "777" },
          ],
          deferred: [{ kind: "plan", key: "093" }],
        },
      })}\n`,
    );

    const out = await index(fs);
    const held = out.pipeline.find((item) => item.number === "093");

    // Only the plan that exists is waited on — and the absent one is named
    // rather than silently trimmed out of somebody's declaration.
    expect(held?.detail.postponed?.waiting_on).toEqual(["plan:091"]);
    expect(held?.detail.postponed?.reason).toContain("plan:777");
    expect(held?.detail.postponed?.reason).toContain("no está en el hub");
  });

  it("la posición declarada se lee en una sola escala entre cortes, y el orden es consistente", async () => {
    const fs = hub();
    fs.file("/cwd/docs/specs/050-spec-otra.md", "---\nstatus: ready-for-plan\n---\n\n# Spec 050\n");
    fs.file(
      "/cwd/docs/plans/051-plan-otra.md",
      [
        "# Plan 051",
        "",
        "> Derived from docs/specs/050-spec-otra.md",
        "> Estado: open",
        "> Límite de ejecución: checkout",
        "",
        "## Tasks",
        "",
        "### F1 — un estado",
        "",
        "> Estado: pendiente",
        "> Fuentes: agent-workflow-cli",
        "",
        "- [ ] T1.1 — algo _(fuentes: agent-workflow-cli)_",
        "",
      ].join("\n"),
    );
    fs.file(
      "/cwd/.workflow/cut-intents.jsonl",
      [
        JSON.stringify({
          version: 1,
          at: "2026-09-14T10:00:00.000Z",
          event: "declared",
          intent: {
            spec: { kind: "spec", key: "090" },
            order: [{ kind: "plan", key: "092" }],
            deferred: [],
          },
        }),
        JSON.stringify({
          version: 1,
          at: "2026-09-14T10:05:00.000Z",
          event: "declared",
          intent: {
            spec: { kind: "spec", key: "050" },
            order: [{ kind: "plan", key: "051" }],
            deferred: [],
          },
        }),
      ].join("\n"),
    );

    const out = await index(fs);
    const plans = out.pipeline.filter((item) => item.kind === "plan-open");
    const declared = plans.filter((item) => item.intent !== undefined).map((item) => item.number);

    // Both are "first" of their own cut, so they tie on the position and fall to
    // the correlative. Reading the position on one scale across cuts is coarser
    // than comparing only within a cut — but only the coarse rule is a real
    // ordering: making different cuts tie while the same cut compares by index
    // admits a cycle, and a comparator with a cycle sorts arbitrarily.
    expect(declared).toEqual(["051", "092"]);
    expect(plans.map((item) => item.number)).toEqual(["051", "092", "091", "093"]);
    // Same input, same answer: the order a sort gives is not implementation
    // defined here.
    const again = await index(fs);
    expect(again.pipeline.map((item) => item.number)).toEqual(
      out.pipeline.map((item) => item.number),
    );
  });

  it("un plan que la intención no menciona conserva el orden por correlativo", async () => {
    const fs = hub();
    plan(fs, "094", "cuatro");
    declareCut(fs);
    passes(fs, false);

    const out = await index(fs);
    const plans = out.pipeline.filter((item) => item.kind === "plan-open");

    // 094 is in no cut: it keeps its place behind the declared ones and ahead of
    // the postponed one, by the correlative rule that governs the undeclared.
    expect(plans.map((item) => item.number)).toEqual(["092", "091", "094", "093"]);
    expect(plans[2]?.intent).toBeUndefined();
  });
});

/**
 * Running ahead of the declared order.
 *
 * The whole point of recording an intent is that somebody may still deviate from
 * it. An order nobody can deviate from is a schedule, and a schedule is exactly
 * what an execution arnés must not impose on the person running it. So this
 * warns, names what it expected, and carries on.
 */
describe("ejecutar fuera del orden declarado advierte y no rechaza", () => {
  it("el plan postergado trae la advertencia con su motivo, y la operación termina en éxito", async () => {
    const fs = hub();
    // Declared standalone so the board has nothing else to warn about on this
    // row: the channel is one field, and this test is about what fills it when
    // the document itself is fine.
    fs.file(
      "/cwd/docs/plans/093-plan-tres.md",
      [
        "# Plan 093",
        "",
        "> Standalone: nació en la conversación, no deriva de ninguna spec",
        "> Estado: open",
        "> Límite de ejecución: checkout",
        "",
        "## Tasks",
        "",
        "### F1 — un estado",
        "",
        "> Estado: pendiente",
        "> Fuentes: agent-workflow-cli",
        "",
        "- [ ] T1.1 — algo _(fuentes: agent-workflow-cli)_",
      ].join("\n"),
    );
    declareCut(fs);
    passes(fs, false);

    const out = await index(fs);
    const held = out.pipeline.find((item) => item.number === "093");

    expect(held?.detail.warning?.code).toBe("WORKLINE_PLAN_OUT_OF_DECLARED_ORDER");
    expect(held?.detail.warning?.message).toContain("v1.0.0");
    expect(held?.detail.warning?.message).toContain("avisa, no bloquea");
    // Success, not refusal: the row keeps a runnable route and its command.
    expect(held?.action.kind).toBe("continue");
    expect(held?.command).toContain("093");

    // And the surface that reads the board returns normally over it.
    const status = await runStatusCommand(fs, env, paths(), { now: NOW });
    expect(status.pipeline.some((item) => item.number === "093")).toBe(true);
  });

  it("ninguna rama convierte el orden declarado en un bloqueo", async () => {
    const declared = hub();
    declareCut(declared);
    passes(declared, false);
    const bare = hub();

    const withCut = await index(declared);
    const without = await index(bare);

    // The decisive assertion of AC-02, and it is a comparison rather than a
    // spot-check: for every plan on the board, the executable route is the SAME
    // with a declared cut and without one. A declared order can move a row and
    // annotate it; it can never take its command away.
    const routes = (items: typeof withCut.pipeline) =>
      new Map(items.map((item) => [item.number, item.action.kind]));
    const a = routes(withCut.pipeline);
    const b = routes(without.pipeline);
    expect([...a.keys()].sort()).toEqual([...b.keys()].sort());
    for (const [number, kind] of a) expect(kind).toBe(b.get(number));
    expect([...a.values()].every((kind) => kind !== "blocked")).toBe(true);
    expect(withCut.pipeline.every((item) => item.command !== null)).toBe(true);
  });

  it("el aviso de orden cede ante un aviso sobre un defecto del documento, y el motivo no se pierde", async () => {
    const fs = hub();
    // A plan with no `Derived from`: the board already warns that nobody sealed
    // its baseline, which is a defect of the document and outranks an advisory.
    fs.file(
      "/cwd/docs/plans/093-plan-tres.md",
      [
        "# Plan 093",
        "",
        "> Estado: open",
        "> Límite de ejecución: checkout",
        "",
        "## Tasks",
        "",
        "### F1 — un estado",
        "",
        "> Estado: pendiente",
        "> Fuentes: agent-workflow-cli",
        "",
        "- [ ] T1.1 — algo _(fuentes: agent-workflow-cli)_",
      ].join("\n"),
    );
    declareCut(fs);
    passes(fs, false);

    const out = await index(fs);
    const held = out.pipeline.find((item) => item.number === "093");

    expect(held?.detail.warning?.code).not.toBe("WORKLINE_PLAN_OUT_OF_DECLARED_ORDER");
    // Ceding the channel never costs the reason: `postponed` carries it anyway,
    // and `status` prints that line on every row that has one.
    expect(held?.detail.postponed?.reason).toContain("v1.0.0");
    expect(held?.action.kind).toBe("continue");
  });

  it("la reanudación tampoco pierde el motivo cuando el aviso de orden cedió el canal", async () => {
    const fs = hub();
    // Same collision as above, asked on the OTHER surface: `warning` is one
    // field and the document's defect takes it, so if `resume` did not carry
    // `postponed` the same plan would be explained by `status` and silently
    // demoted by `resume`.
    fs.file(
      "/cwd/docs/plans/093-plan-tres.md",
      [
        "# Plan 093",
        "",
        "> Estado: open",
        "> Límite de ejecución: checkout",
        "",
        "## Tasks",
        "",
        "### F1 — un estado",
        "",
        "> Estado: pendiente",
        "> Fuentes: agent-workflow-cli",
        "",
        "- [ ] T1.1 — algo _(fuentes: agent-workflow-cli)_",
      ].join("\n"),
    );
    declareCut(fs);
    passes(fs, false);

    const out = await runResume(fs, env, paths(), { now: NOW });

    expect(out.status).toBe("proposal");
    if (out.status !== "proposal") return;
    const held = (out.candidates ?? []).find((candidate) => candidate.number === "093");
    expect(held?.warning?.code).not.toBe("WORKLINE_PLAN_OUT_OF_DECLARED_ORDER");
    expect(held?.postponed?.reason).toContain("v1.0.0");
    expect(held?.postponed?.waiting_on).toEqual(["plan:092", "plan:091"]);
  });

  it("sin intención declarada no aparece ningún aviso de orden", async () => {
    const out = await index(hub());
    expect(
      out.pipeline.every(
        (item) => item.detail.warning?.code !== "WORKLINE_PLAN_OUT_OF_DECLARED_ORDER",
      ),
    ).toBe(true);
  });
});
