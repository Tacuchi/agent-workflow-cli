import { describe, expect, it } from "vitest";
import { resolveFromPlan, transitionPlanState } from "../../src/application/from-plan.js";
import { PathsService } from "../../src/application/paths-service.js";
import type { DirEntry, FileStat, FileSystemPort } from "../../src/ports/file-system.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";

class FakeFs implements FileSystemPort {
  public writes: Map<string, string> = new Map();
  constructor(
    private files: Map<string, string> = new Map(),
    private dirs: Map<string, DirEntry[]> = new Map(),
  ) {}
  async readText(p: string) {
    if (this.writes.has(p)) return this.writes.get(p) ?? "";
    const v = this.files.get(p);
    if (v === undefined) throw new Error(`ENOENT: ${p}`);
    return v;
  }
  async writeText(p: string, c: string): Promise<void> {
    this.writes.set(p, c);
  }
  async exists(p: string) {
    return this.files.has(p) || this.dirs.has(p) || this.writes.has(p);
  }
  async list(p: string): Promise<DirEntry[]> {
    const v = this.dirs.get(p);
    if (v === undefined) throw new Error(`ENOENT: ${p}`);
    return v;
  }
  async mkdirp(): Promise<void> {}
  async stat(): Promise<FileStat> {
    return { mtime: new Date(0), size: 0, type: "file" };
  }
}

const ns = normalizeNamespace("workflow");
const paths = new PathsService(ns, "/home/u", "/cwd");
const planesDir = "/cwd/docs/planes";

const VALID_PLAN = `---
state: draft
sessions: [055, 062]
created: 2026-05-18
slug: export-plan
state_changes:
  - {from: null, to: draft, when: '2026-05-18T22:00:00Z', trigger: 'export-plan create'}
---

# Plan — Smoke

## Resumen

Plan ejemplo para testear F-E.3. Sintetiza session055 + session062.

## Tasks

| T1 | foo | 1h | exec | — | session055:T3 |
`;

function buildFs(plans: Record<string, string>): FakeFs {
  const files = new Map<string, string>(Object.entries(plans));
  const dirs = new Map<string, DirEntry[]>([
    [
      planesDir,
      Object.keys(plans).map((p) => ({
        name: p.slice(p.lastIndexOf("/") + 1),
        path: p,
        type: "file" as const,
      })),
    ],
  ]);
  return new FakeFs(files, dirs);
}

describe("resolveFromPlan", () => {
  it("resolves a valid plan by NNN", async () => {
    const planPath = `${planesDir}/001-export-plan-2026-05-18.md`;
    const fs = buildFs({ [planPath]: VALID_PLAN });
    const result = await resolveFromPlan(fs, paths, "/cwd", "001");
    if ("code" in result) throw new Error(`unexpected error: ${result.message}`);
    expect(result.frontmatter.state).toBe("draft");
    expect(result.frontmatter.sessions).toEqual(["055", "062"]);
    expect(result.frontmatter.slug).toBe("export-plan");
    expect(result.filename).toBe("001-export-plan-2026-05-18.md");
    expect(result.resumen).toContain("session055");
  });

  it("normalizes 1-digit NNN to 3 digits", async () => {
    const planPath = `${planesDir}/001-export-plan-2026-05-18.md`;
    const fs = buildFs({ [planPath]: VALID_PLAN });
    const result = await resolveFromPlan(fs, paths, "/cwd", "1");
    if ("code" in result) throw new Error(`unexpected error: ${result.message}`);
    expect(result.frontmatter.slug).toBe("export-plan");
  });

  it("resolves a plan by absolute path", async () => {
    const planPath = `${planesDir}/001-export-plan-2026-05-18.md`;
    const fs = buildFs({ [planPath]: VALID_PLAN });
    const result = await resolveFromPlan(fs, paths, "/cwd", planPath);
    if ("code" in result) throw new Error(`unexpected error: ${result.message}`);
    expect(result.frontmatter.state).toBe("draft");
  });

  it("resolves a plan by relative path", async () => {
    const planPath = `${planesDir}/001-export-plan-2026-05-18.md`;
    const fs = buildFs({ [planPath]: VALID_PLAN });
    const result = await resolveFromPlan(
      fs,
      paths,
      "/cwd",
      "docs/planes/001-export-plan-2026-05-18.md",
    );
    if ("code" in result) throw new Error(`unexpected error: ${result.message}`);
    expect(result.frontmatter.state).toBe("draft");
  });

  it("returns PLAN_NOT_FOUND for missing NNN", async () => {
    const fs = buildFs({});
    const result = await resolveFromPlan(fs, paths, "/cwd", "999");
    if (!("code" in result)) throw new Error("expected error");
    expect(result.code).toBe("PLAN_NOT_FOUND");
  });

  it("returns PLAN_NOT_FOUND for invalid input", async () => {
    const fs = buildFs({});
    const result = await resolveFromPlan(fs, paths, "/cwd", "abc");
    if (!("code" in result)) throw new Error("expected error");
    expect(result.code).toBe("PLAN_NOT_FOUND");
  });

  it("returns INVALID_INPUT for empty raw", async () => {
    const fs = buildFs({});
    const result = await resolveFromPlan(fs, paths, "/cwd", "   ");
    if (!("code" in result)) throw new Error("expected error");
    expect(result.code).toBe("INVALID_INPUT");
  });

  it("returns PLAN_INVALID_FRONTMATTER for plan without frontmatter", async () => {
    const planPath = `${planesDir}/001-broken.md`;
    const fs = buildFs({ [planPath]: "# Plan without frontmatter\n" });
    const result = await resolveFromPlan(fs, paths, "/cwd", "001");
    if (!("code" in result)) throw new Error("expected error");
    expect(result.code).toBe("PLAN_INVALID_FRONTMATTER");
  });

  it("returns PLAN_ARCHIVED for archived plan", async () => {
    const archivedPlan = VALID_PLAN.replace("state: draft", "state: archived");
    const planPath = `${planesDir}/001-archived.md`;
    const fs = buildFs({ [planPath]: archivedPlan });
    const result = await resolveFromPlan(fs, paths, "/cwd", "001");
    if (!("code" in result)) throw new Error("expected error");
    expect(result.code).toBe("PLAN_ARCHIVED");
  });

  it("accepts active plan (no-op transition later)", async () => {
    const activePlan = VALID_PLAN.replace("state: draft", "state: active");
    const planPath = `${planesDir}/001-active.md`;
    const fs = buildFs({ [planPath]: activePlan });
    const result = await resolveFromPlan(fs, paths, "/cwd", "001");
    if ("code" in result) throw new Error(`unexpected error: ${result.message}`);
    expect(result.frontmatter.state).toBe("active");
  });

  it("accepts done plan (sugiere advertencia al caller)", async () => {
    const donePlan = VALID_PLAN.replace("state: draft", "state: done");
    const planPath = `${planesDir}/001-done.md`;
    const fs = buildFs({ [planPath]: donePlan });
    const result = await resolveFromPlan(fs, paths, "/cwd", "001");
    if ("code" in result) throw new Error(`unexpected error: ${result.message}`);
    expect(result.frontmatter.state).toBe("done");
  });
});

describe("transitionPlanState", () => {
  it("transitions draft → active and appends to state_changes", async () => {
    const planPath = `${planesDir}/001-export-plan-2026-05-18.md`;
    const fs = buildFs({ [planPath]: VALID_PLAN });
    const resolved = await resolveFromPlan(fs, paths, "/cwd", "001");
    if ("code" in resolved) throw new Error("expected success");

    const result = await transitionPlanState(fs, resolved, "active", "session-create 067");
    expect(result.wrote).toBe(true);
    expect(result.from).toBe("draft");

    const updated = fs.writes.get(planPath);
    expect(updated).toBeDefined();
    expect(updated).toContain("state: active");
    expect(updated).toContain("from: draft, to: active");
    expect(updated).toContain("session-create 067");
    // Append-only: previa entry preservada.
    expect(updated).toContain("export-plan create");
  });

  it("is idempotent when target state matches current", async () => {
    const activePlan = VALID_PLAN.replace("state: draft", "state: active");
    const planPath = `${planesDir}/001-active.md`;
    const fs = buildFs({ [planPath]: activePlan });
    const resolved = await resolveFromPlan(fs, paths, "/cwd", "001");
    if ("code" in resolved) throw new Error("expected success");

    const result = await transitionPlanState(fs, resolved, "active", "session-create 067");
    expect(result.wrote).toBe(false);
    expect(fs.writes.has(planPath)).toBe(false);
  });

  it("transitions active → done (session-close path R4)", async () => {
    const activePlan = VALID_PLAN.replace("state: draft", "state: active");
    const planPath = `${planesDir}/001-active.md`;
    const fs = buildFs({ [planPath]: activePlan });
    const resolved = await resolveFromPlan(fs, paths, "/cwd", "001");
    if ("code" in resolved) throw new Error("expected success");

    const result = await transitionPlanState(fs, resolved, "done", "session-close 073");
    expect(result.wrote).toBe(true);
    expect(result.from).toBe("active");

    const updated = fs.writes.get(planPath);
    expect(updated).toBeDefined();
    expect(updated).toContain("state: done");
    expect(updated).toContain("from: active, to: done");
    expect(updated).toContain("session-close 073");
    // Append-only: la entry previa de draft → ? sigue preservada (aunque acá empezó como active).
    expect(updated).toContain("export-plan create");
  });

  it("done → done es idempotente (R4 skip silencioso)", async () => {
    const donePlan = VALID_PLAN.replace("state: draft", "state: done");
    const planPath = `${planesDir}/001-done.md`;
    const fs = buildFs({ [planPath]: donePlan });
    const resolved = await resolveFromPlan(fs, paths, "/cwd", "001");
    if ("code" in resolved) throw new Error("expected success");

    const result = await transitionPlanState(fs, resolved, "done", "session-close 073");
    expect(result.wrote).toBe(false);
    expect(fs.writes.has(planPath)).toBe(false);
  });
});
