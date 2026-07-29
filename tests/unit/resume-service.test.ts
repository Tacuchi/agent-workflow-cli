import { describe, expect, it } from "vitest";
import { PathsService } from "../../src/application/paths-service.js";
import { type ResumeInput, runResume } from "../../src/application/resume-service.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { MemFs } from "../helpers/mem-fs.js";

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
      next: "- cerrar F3",
      command: "aw session-resume --code 049-x-plan-exec --reopen",
    });
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
