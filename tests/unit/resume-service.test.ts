import { describe, expect, it } from "vitest";
import { PathsService } from "../../src/application/paths-service.js";
import { type ResumeInput, runResume } from "../../src/application/resume-service.js";
import { runStatusCommand } from "../../src/application/status-service.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { MemFs } from "../helpers/mem-fs.js";
import {
  HANDOFF_PLAN,
  HANDOFF_TEXT,
  seedClosedPlanWithHandoff,
} from "../helpers/plan-obligation-fixtures.js";

const fakeEnv = new FakeEnv("/home", "/cwd");
const NOW = new Date(2026, 6, 29, 12, 0, 0);

function paths(): PathsService {
  return new PathsService(normalizeNamespace("workflow"), "/home", "/cwd");
}

function resume(fs: MemFs, input: ResumeInput = {}) {
  return runResume(fs, fakeEnv, paths(), { ...input, now: NOW });
}

function workspace(): MemFs {
  const fs = new MemFs();
  fs.file("/cwd/.workflow/sessions/.keep", "");
  return fs;
}

const READY = "---\nstatus: ready-for-plan\n---\n\n# Spec\n";
const DRAFT = "---\nstatus: draft\n---\n\n# Spec\n";

function session(fs: MemFs, folder: string, objective: string, origin: string, pending: string) {
  fs.file(
    `/cwd/.workflow/sessions/${folder}/SESSION.md`,
    `# SESSION\n\n## Objective\n${objective}\n\n## Origin\n- ${origin}\n`,
  );
  fs.file(
    `/cwd/.workflow/sessions/${folder}/CHECKPOINT.md`,
    `# CHECKPOINT\n\n## Completed\n- algo hecho\n\n## Pending / Next\n- ${pending}\n`,
  );
}

// ── no target: the documental pipeline ───────────────────────────────────────

describe("runResume — without a target it follows the documental priority", () => {
  it("fails closed when the core documentary canon is invalid", async () => {
    const fs = workspace();
    fs.file("/cwd/.workflow/skills.toml", '[docs]\nspec = "knowledge/specs"\n');

    const out = await resume(fs);

    expect(out.status).toBe("invalid_target");
    if (out.status !== "invalid_target") return;
    expect(out.action).toContain("canon documental");
  });

  it("recommends the unrefined spec over a partial plan and a loose checkpoint", async () => {
    const fs = workspace();
    fs.file("/cwd/docs/specs/001-spec-borrador.md", DRAFT);
    fs.file("/cwd/docs/plans/005-plan-parcial.md", "# Plan\n\n## Tasks\n- [x] T1\n- [ ] T2\n");
    session(fs, "010-suelta-quick", "algo suelto", "prompt directo", "seguir");

    const out = await resume(fs);
    expect(out.status).toBe("proposal");
    if (out.status !== "proposal") return;
    expect(out.via).toBe("pipeline");
    expect(out.proposal.kind).toBe("spec-unrefined");
    expect(out.proposal.command).toBe("/w:spec-refine docs/specs/001-spec-borrador.md");
  });

  it("reports every field the caller needs to decide, plus the exact route", async () => {
    const fs = workspace();
    fs.file(
      "/cwd/docs/plans/009-plan-x.md",
      "# Plan\n\n## Tasks\n- [x] T1\n- [x] T2\n- [ ] T3\n- [ ] T4\n",
    );

    const out = await resume(fs);
    if (out.status !== "proposal") throw new Error(`expected a proposal, got ${out.status}`);
    expect(out.proposal).toMatchObject({
      kind: "plan-open",
      number: "009",
      objective: "plan 009 — x",
      progress: "2/4 tareas (50%)",
      command: "/w:plan-exec docs/plans/009-plan-x.md",
    });
  });

  it("surfaces a blocked phase as what the plan is waiting on", async () => {
    const fs = workspace();
    fs.file(
      "/cwd/docs/plans/003-plan-b.md",
      "# Plan\n\n## Tasks\n\n### F1 — algo\n\n> Estado: bloqueada\n> Bloqueo: falta aplicar la migración 014\n\n- [x] T1.1\n",
    );

    const out = await resume(fs);
    if (out.status !== "proposal") throw new Error(`expected a proposal, got ${out.status}`);
    expect(out.proposal.next).toContain("migración 014");
  });

  it("returns candidates on a tie and refuses to break it by date", async () => {
    const fs = workspace();
    fs.file("/cwd/docs/specs/001-spec-vieja.md", DRAFT, new Date(2020, 0, 1));
    fs.file("/cwd/docs/specs/002-spec-nueva.md", DRAFT, new Date(2026, 6, 28));

    const out = await resume(fs);
    expect(out.status).toBe("candidates");
    if (out.status !== "candidates") return;
    expect(out.candidates.map((c) => c.number)).toEqual(["001", "002"]);
  });

  it("says the pipeline is empty instead of inventing something to do", async () => {
    const fs = workspace();
    fs.file(
      "/cwd/docs/plans/001-plan-a.md",
      "# Plan\n\n> Estado: done\n> Derived from docs/specs/003-spec-a.md\n\n## Tasks\n- [x] T1\n",
    );
    fs.file("/cwd/docs/specs/003-spec-a.md", READY);

    const out = await resume(fs);
    expect(out.status).toBe("idle");
  });
});

// ── explicit target ──────────────────────────────────────────────────────────

describe("runResume — an explicit target wins over the pipeline", () => {
  it("resolves a plan by its path even when a spec outranks it", async () => {
    const fs = workspace();
    fs.file("/cwd/docs/specs/001-spec-borrador.md", DRAFT);
    fs.file("/cwd/docs/plans/005-plan-x.md", "# Plan\n\n## Tasks\n- [ ] T1\n");

    const out = await resume(fs, { target: "docs/plans/005-plan-x.md" });
    if (out.status !== "proposal") throw new Error(`expected a proposal, got ${out.status}`);
    expect(out.via).toBe("explicit");
    expect(out.proposal.number).toBe("005");
  });

  it("resolves a bare number when only one document carries it", async () => {
    const fs = workspace();
    fs.file("/cwd/docs/plans/005-plan-x.md", "# Plan\n\n## Tasks\n- [ ] T1\n");

    const out = await resume(fs, { target: "005" });
    if (out.status !== "proposal") throw new Error(`expected a proposal, got ${out.status}`);
    expect(out.proposal.file).toBe("docs/plans/005-plan-x.md");
  });

  it("preserves the compatible legacy warning on an explicit open plan", async () => {
    const fs = workspace();
    fs.file("/cwd/docs/plans/006-plan-legado.md", "# Plan\n\n## Tasks\n- [ ] T1\n");

    const out = await resume(fs, { target: "docs/plans/006-plan-legado.md" });
    if (out.status !== "proposal") throw new Error(`expected a proposal, got ${out.status}`);
    expect(out.proposal.command).toBe("/w:plan-exec docs/plans/006-plan-legado.md");
    expect(out.proposal.warning?.code).toBe("WORKLINE_BASELINE_LEGACY_UNSEALED");
  });

  it("does not offer plan-exec for a closed legacy plan targeted explicitly", async () => {
    const fs = workspace();
    fs.file(
      "/cwd/docs/plans/007-plan-historico.md",
      "# Plan\n\n> Estado: done\n\n## Tasks\n- [x] T1\n",
    );

    const out = await resume(fs, { target: "docs/plans/007-plan-historico.md" });
    expect(out.status).toBe("invalid_target");
    if (out.status !== "invalid_target") return;
    expect(out.action).toContain("histórico");
    expect(out.action).not.toContain("/w:plan-exec");
  });

  // A number is not an identity: spec 005 and plan 005 both exist in real
  // workspaces, so the tie goes back to the caller.
  it("returns candidates when a number names both a spec and a plan", async () => {
    const fs = workspace();
    fs.file("/cwd/docs/specs/005-spec-x.md", DRAFT);
    fs.file("/cwd/docs/plans/005-plan-y.md", "# Plan\n\n## Tasks\n- [ ] T1\n");

    const out = await resume(fs, { target: "005" });
    expect(out.status).toBe("candidates");
    if (out.status !== "candidates") return;
    expect(out.candidates.map((c) => c.file)).toEqual([
      "docs/specs/005-spec-x.md",
      "docs/plans/005-plan-y.md",
    ]);
  });

  it("rejects a target that matches nothing, naming both accepted forms", async () => {
    const out = await resume(workspace(), { target: "404" });
    expect(out.status).toBe("invalid_target");
    if (out.status !== "invalid_target") return;
    expect(out.action).toContain("--code");
  });

  it("reads a session target through --code", async () => {
    const fs = workspace();
    session(fs, "049-x-plan-exec", "ejecutar el plan 008", "docs/plans/008-plan-x.md", "cerrar F3");

    const out = await resume(fs, { code: "049" });
    if (out.status !== "proposal") throw new Error(`expected a proposal, got ${out.status}`);
    expect(out.proposal).toMatchObject({
      kind: "session",
      objective: "ejecutar el plan 008",
      // Sin la viñeta: el próximo paso ahora viene de la narrativa, que lee cada
      // ítem como un hecho y no como una línea de Markdown.
      next: "cerrar F3",
      command: "aw session-resume --code 049-x-plan-exec --reopen",
    });
    // Y esa narrativa dice de qué estado viene: una sesión con avance registrado
    // es una que alguien dejó y retomó, no una recién abierta.
    expect(out.proposal.progress).toContain("sesión");
  });
});

// ── the read-only guarantee ──────────────────────────────────────────────────

describe("runResume — reads state, never records it", () => {
  // Plan 008 made every session-scoped READ record the conversation→session
  // association (`sessionReadRequest` sets `bind: true`). `resume` must not:
  // asking what to pick up is not the same as claiming a work line.
  it("leaves .bindings.json untouched when resolving a session by code", async () => {
    const fs = workspace();
    session(fs, "049-x-plan-exec", "ejecutar", "docs/plans/008-plan-x.md", "seguir");

    const out = await resume(fs, { code: "049", contextId: "conversation-abc" });
    expect(out.status).toBe("proposal");
    expect(fs.writes.size).toBe(0);
    expect(await fs.exists("/cwd/.workflow/sessions/.bindings.json")).toBe(false);
  });

  it("does not create a binding when the conversation resolves the sole active session", async () => {
    const fs = workspace();
    session(fs, "049-x-plan-exec", "ejecutar", "docs/plans/008-plan-x.md", "seguir");

    await resume(fs, { code: "049-x-plan-exec", contextId: "conversation-xyz" });
    expect([...fs.writes.keys()]).toEqual([]);
  });

  it("writes nothing at all on the pipeline path either", async () => {
    const fs = workspace();
    fs.file("/cwd/docs/specs/001-spec-borrador.md", DRAFT);
    fs.file("/cwd/docs/plans/005-plan-x.md", "# Plan\n\n## Tasks\n- [ ] T1\n");
    session(fs, "010-suelta-quick", "algo", "prompt", "seguir");

    await resume(fs);
    expect(fs.writes.size).toBe(0);
  });
});

// ── the whole pipeline is the offer ──────────────────────────────────────────

/**
 * `resume` used to offer the head of the pipeline and its ties, and nothing else.
 *
 * So the open plans below them were pending work `status` listed and `resume`
 * never named: choosing what to pick up meant reading one surface and typing from
 * the other. What must NOT change is who decides — priority, the tie-break and
 * the spec→plan link stay the CLI's, and the command is still only presented.
 */
function nine(): MemFs {
  const fs = workspace();
  for (const n of ["001", "002", "003"]) fs.file(`/cwd/docs/specs/${n}-spec-borrador.md`, DRAFT);
  for (const n of ["004", "005"]) fs.file(`/cwd/docs/specs/${n}-spec-lista.md`, READY);
  for (const n of ["010", "011", "012", "013"]) {
    fs.file(`/cwd/docs/plans/${n}-plan-abierto.md`, "# Plan\n\n## Tasks\n- [ ] T1\n");
  }
  return fs;
}

describe("runResume — sin target, la oferta es el pipeline completo", () => {
  it("devuelve los 9 pendientes de las tres clases, en el orden del CLI", async () => {
    const out = await resume(nine());
    if (out.status !== "candidates") throw new Error(`esperaba candidates, vino ${out.status}`);

    expect(out.candidates.map((c) => [c.kind, c.number])).toEqual([
      ["spec-unrefined", "001"],
      ["spec-unrefined", "002"],
      ["spec-unrefined", "003"],
      ["spec-unplanned", "004"],
      ["spec-unplanned", "005"],
      ["plan-open", "010"],
      ["plan-open", "011"],
      ["plan-open", "012"],
      ["plan-open", "013"],
    ]);
    // El empate de cabeza sigue siendo el empate, y se dice sobre cuántos.
    expect(out.action).toContain("3 candidatos empatados en cabeza sobre 9 pendientes");
  });

  it("cada candidato lleva su progreso, su siguiente y su comando de re-entrada", async () => {
    const out = await resume(nine());
    if (out.status !== "candidates") throw new Error(`esperaba candidates, vino ${out.status}`);

    for (const candidate of out.candidates) {
      expect(candidate.progress).not.toBe("");
      expect(candidate.next).not.toBe("");
      expect(candidate.command).toMatch(/^\/w:(spec-refine|plan-new|plan-exec) docs\//);
    }
  });

  it("sin empate hay recomendación Y el resto de la oferta, no una sola cosa", async () => {
    const fs = workspace();
    fs.file("/cwd/docs/specs/001-spec-borrador.md", DRAFT);
    fs.file("/cwd/docs/plans/010-plan-abierto.md", "# Plan\n\n## Tasks\n- [ ] T1\n");
    fs.file("/cwd/docs/plans/011-plan-abierto.md", "# Plan\n\n## Tasks\n- [ ] T1\n");

    const out = await resume(fs);
    if (out.status !== "proposal") throw new Error(`esperaba una propuesta, vino ${out.status}`);
    expect(out.proposal.number).toBe("001");
    // Los planes abiertos que antes quedaban fuera de la oferta ahora entran.
    expect(out.candidates?.map((c) => c.number)).toEqual(["001", "010", "011"]);
  });

  it("y describe cada ítem igual que el tablero: una sola derivación", async () => {
    const fs = nine();
    const board = await runStatusCommand(fs, fakeEnv, paths(), { now: NOW });
    const out = await resume(fs);
    if (out.status !== "candidates") throw new Error(`esperaba candidates, vino ${out.status}`);

    expect(out.candidates.map((c) => [c.objective, c.progress, c.next])).toEqual(
      board.pipeline.map((i) => [i.detail.objective, i.detail.progress, i.detail.next]),
    );
  });

  it("sin pendientes sigue devolviendo idle, sin abrir ninguna elección", async () => {
    const fs = workspace();
    fs.file(
      "/cwd/docs/plans/001-plan-a.md",
      "# Plan\n\n> Estado: done\n> Derived from docs/specs/003-spec-a.md\n\n## Tasks\n- [x] T1\n",
    );
    fs.file("/cwd/docs/specs/003-spec-a.md", READY);

    const out = await resume(fs);
    expect(out.status).toBe("idle");
  });

  it("un directorio implícito sin pipeline devuelve idle, sin exigir inicialización", async () => {
    const out = await resume(new MemFs({ lenient: true }));
    expect(out.status).toBe("idle");
  });
});

describe("runResume — lo que la oferta ampliada NO cambió", () => {
  it("un target explícito sigue ganándole al pipeline y no trae candidatos", async () => {
    const fs = nine();
    const out = await resume(fs, { target: "docs/plans/012-plan-abierto.md" });
    if (out.status !== "proposal") throw new Error(`esperaba una propuesta, vino ${out.status}`);

    expect(out.via).toBe("explicit");
    expect(out.proposal.number).toBe("012");
    expect(out.candidates).toBeUndefined();
  });

  it("--code sigue resolviendo la sesión y sin escribir nada", async () => {
    const fs = nine();
    session(fs, "049-x-plan-exec", "ejecutar el plan 008", "docs/plans/008-plan-x.md", "cerrar F3");

    const out = await resume(fs, { code: "049" });
    if (out.status !== "proposal") throw new Error(`esperaba una propuesta, vino ${out.status}`);
    expect(out.proposal.kind).toBe("session");
    expect(out.candidates).toBeUndefined();
    expect(fs.writes.size).toBe(0);
  });

  it("ofrecer los 9 tampoco escribe ni ejecuta nada", async () => {
    const fs = nine();
    await resume(fs);
    expect(fs.writes.size).toBe(0);
  });
});

// F4 · T4.3 — la otra superficie del mismo hecho. `status` lo lista y `resume`
// lo ofrece, y lo que se fija es que digan LO MISMO: la fila y la propuesta
// salen de una sola derivación, así que un traspaso vigente no puede leerse
// distinto según por dónde se pregunte.
describe("runResume — el traspaso de un plan cerrado se ofrece sin bloquear", () => {
  const expected = `TRASPASO VIGENTE por DEC-001 — ${HANDOFF_TEXT}`;

  it("lo propone con su comando cuando no hay nada abierto que le gane", async () => {
    const fs = workspace();
    seedClosedPlanWithHandoff(fs);

    const out = await resume(fs);

    expect(out.status).toBe("proposal");
    if (out.status !== "proposal") return;
    expect(out.proposal.kind).toBe("plan-handoff");
    expect(out.proposal.file).toBe(HANDOFF_PLAN);
    expect(out.proposal.next).toContain(expected);
    expect(out.proposal.command).toBe(`aw settle prepare ${HANDOFF_PLAN}`);
  });

  it("un plan ABIERTO le gana: el traspaso no adelanta trabajo de afuera", async () => {
    const fs = workspace();
    seedClosedPlanWithHandoff(fs);
    fs.file("/cwd/docs/plans/005-plan-abierto.md", "# Plan\n\n## Tasks\n- [x] T1\n- [ ] T2\n");

    const out = await resume(fs);

    expect(out.status).toBe("proposal");
    if (out.status !== "proposal") return;
    expect(out.proposal.file).toBe("docs/plans/005-plan-abierto.md");
    // Y sigue estando: no gana la propuesta, pero no desaparece del listado.
    expect(out.candidates?.map((c) => c.file)).toContain(HANDOFF_PLAN);
  });

  it("preguntado por el plan mismo dice exactamente lo que dice el tablero", async () => {
    const fs = workspace();
    seedClosedPlanWithHandoff(fs);

    const direct = await resume(fs, { target: HANDOFF_PLAN });
    const board = await runStatusCommand(fs, fakeEnv, paths(), { now: NOW });
    const row = board.pipeline.find((item) => item.file === HANDOFF_PLAN);

    expect(direct.status).toBe("proposal");
    if (direct.status !== "proposal") return;
    // El mismo titular y el mismo comando, palabra por palabra: dos derivaciones
    // es cómo estas dos superficies llegaron a describir distinto un mismo ítem.
    expect(direct.proposal.next).toBe(row?.detail.next);
    expect(direct.proposal.command).toBe(row?.command);
    expect(direct.proposal.kind).toBe(row?.kind);
  });
});
