import { describe, expect, it } from "vitest";
import { PathsService } from "../../src/application/paths-service.js";
import { runWorkspaceInit } from "../../src/application/workspace-init-service.js";
import {
  MaterializingWorkspaceFileSystem,
  ensureWorklineMaterialized,
  previewWorklineMaterialization,
} from "../../src/application/workspace-materialization-service.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { MemFs } from "../helpers/mem-fs.js";

const namespace = normalizeNamespace("workflow");

function paths(root = "/cwd"): PathsService {
  return new PathsService(namespace, "/home/u", root);
}

describe("Workline implicit materialization", () => {
  it("keeps a virgin non-Git read preview byte-identical", async () => {
    const fs = new MemFs();
    fs.dir("/cwd");

    const preview = await previewWorklineMaterialization(fs, paths());

    expect(preview).toMatchObject({ root: "/cwd", namespace: "workflow", materialized: true });
    expect(preview.effects).toEqual([
      { kind: "gitignore", path: "/cwd/.gitignore", status: "skipped" },
      { kind: "sessions", path: "/cwd/.workflow/sessions", status: "created" },
    ]);
    expect(fs.writes).toEqual(new Map());
    expect(await fs.exists("/cwd/.workflow")).toBe(false);
  });

  it("creates only the runtime ignore block and canonical marker on first Git mutation", async () => {
    const fs = new MemFs();
    fs.dir("/repo").dir("/repo/.git");

    const result = await ensureWorklineMaterialized(fs, paths("/repo"));

    expect(result.materialized).toBe(true);
    expect(result.effects).toEqual([
      { kind: "gitignore", path: "/repo/.gitignore", status: "created" },
      { kind: "sessions", path: "/repo/.workflow/sessions", status: "created" },
    ]);
    await expect(fs.readText("/repo/.gitignore")).resolves.toContain(".workflow/sessions/");
    expect(await fs.exists("/repo/.workflow/sessions")).toBe(true);
    expect(await fs.exists("/repo/.workflow/.lock")).toBe(false);
    expect(await fs.exists("/repo/.workflow/skills.toml")).toBe(false);
    expect(await fs.exists("/repo/CLAUDE.md")).toBe(false);
  });

  it("previews an existing Git ignore file as updated when its runtime block is incomplete", async () => {
    const fs = new MemFs();
    fs.dir("/repo").dir("/repo/.git");
    fs.file("/repo/.gitignore", "node_modules/\n");

    const preview = await previewWorklineMaterialization(fs, paths("/repo"));

    expect(preview.effects[0]).toEqual({
      kind: "gitignore",
      path: "/repo/.gitignore",
      status: "updated",
    });
    expect(fs.writes).toEqual(new Map());
  });

  it("is idempotent after the marker is materialized", async () => {
    const fs = new MemFs();
    fs.dir("/cwd");
    await ensureWorklineMaterialized(fs, paths());
    fs.writes.clear();

    const second = await ensureWorklineMaterialized(fs, paths());

    expect(second.materialized).toBe(false);
    expect(second.effects).toEqual([
      { kind: "sessions", path: "/cwd/.workflow/sessions", status: "existing" },
    ]);
    expect(fs.writes).toEqual(new Map());
  });

  it("serializes two concurrent first mutations into one creation and one existing receipt", async () => {
    const fs = new MemFs();
    fs.dir("/cwd");

    const results = await Promise.all([
      ensureWorklineMaterialized(fs, paths()),
      ensureWorklineMaterialized(fs, paths()),
    ]);

    expect(results.map((result) => result.materialized).sort()).toEqual([false, true]);
    expect(await fs.exists("/cwd/.workflow/sessions")).toBe(true);
    expect(await fs.exists("/cwd/.workflow/.lock")).toBe(false);
  });

  it("guards a direct workspace writer so it materializes before writing docs", async () => {
    const raw = new MemFs();
    raw.dir("/cwd");
    const fs = new MaterializingWorkspaceFileSystem(raw, paths());

    await fs.writeText("/cwd/docs/specs/001-spec-x.md", "# x\n");

    expect(await raw.exists("/cwd/.workflow/sessions")).toBe(true);
    expect(await raw.readText("/cwd/docs/specs/001-spec-x.md")).toBe("# x\n");
    expect(fs.materialization()).toMatchObject({ materialized: true });
    expect(await raw.exists("/cwd/CLAUDE.md")).toBe(false);
  });

  it("does not materialize for reads or writes outside the resolved root", async () => {
    const raw = new MemFs();
    raw.dir("/cwd").dir("/outside");
    const fs = new MaterializingWorkspaceFileSystem(raw, paths());

    await fs.exists("/cwd/docs");
    await fs.writeText("/outside/note.txt", "external\n");

    expect(fs.materialization()).toBeUndefined();
    expect(await raw.exists("/cwd/.workflow")).toBe(false);
    expect(await raw.readText("/outside/note.txt")).toBe("external\n");
  });

  it("workspace-init without sources is materialization only", async () => {
    const fs = new MemFs();
    fs.dir("/cwd");
    const result = await runWorkspaceInit(fs, new FakeEnv("/home/u", "/cwd"), paths(), {
      sources: [],
    });

    if ("error" in result) throw new Error(result.error);
    expect(result.sources).toBe(0);
    expect(result.project_md).toEqual({ skipped: true, reason: "materialization_only" });
    expect(result.skills_toml).toBe("skipped");
    expect(await fs.exists("/cwd/.workflow/sessions")).toBe(true);
    expect(await fs.exists("/cwd/CLAUDE.md")).toBe(false);
    expect(await fs.exists("/cwd/AGENTS.md")).toBe(false);
  });

  it("reserves workspace as the implicit root source alias", async () => {
    const fs = new MemFs();
    fs.dir("/cwd");
    const result = await runWorkspaceInit(fs, new FakeEnv("/home/u", "/cwd"), paths(), {
      sources: [{ alias: "workspace", path: "/other" }],
    });

    expect(result).toMatchObject({ error: "reserved_source_alias" });
    expect(await fs.exists("/cwd/.workflow/sessions")).toBe(false);
  });
});
