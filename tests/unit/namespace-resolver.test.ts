import { describe, expect, it } from "vitest";
import type { DirEntry } from "../../src/ports/file-system.js";
import { NamespaceResolver } from "../../src/runtime/namespace-resolver.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { MemFs } from "../helpers/mem-fs.js";

// Rebuilds the old FakeFs(files, dirs) shape on the shared MemFs: seed files and
// the explicit dir listings the resolver walks. Strict on unregistered paths
// (list throws ENOENT) — matching the original fake.
function makeFs(
  files: Map<string, string> = new Map(),
  dirs: Map<string, DirEntry[]> = new Map(),
): MemFs {
  const fs = new MemFs();
  for (const [p, content] of files) fs.file(p, content);
  for (const [dir, entries] of dirs) {
    fs.dir(dir);
    for (const e of entries) {
      if (e.type === "dir") fs.dir(e.path);
      else fs.file(e.path, files.get(e.path) ?? "");
    }
  }
  return fs;
}

describe("NamespaceResolver", () => {
  const CONFIG_PATH = "/home/u/.config/agent-workflow/namespace";

  it("returns default 'workflow' when no flag/env/config", async () => {
    const r = new NamespaceResolver(makeFs(), new FakeEnv("/home/u", "/cwd"));
    const result = await r.resolve(undefined);
    expect(result.namespace).toBe("workflow");
    expect(result.source).toBe("default");
  });

  it("flag wins over env", async () => {
    const env = new FakeEnv("/home/u", "/cwd", { AW_NAMESPACE: "envwin" });
    const r = new NamespaceResolver(makeFs(), env);
    const result = await r.resolve("flagwin");
    expect(result.namespace).toBe("flagwin");
    expect(result.source).toBe("flag");
  });

  it("env wins over config file", async () => {
    const env = new FakeEnv("/home/u", "/cwd", { AW_NAMESPACE: "envns" });
    const fs = makeFs(new Map([[CONFIG_PATH, "configns\n"]]));
    const r = new NamespaceResolver(fs, env);
    const result = await r.resolve(undefined);
    expect(result.namespace).toBe("envns");
    expect(result.source).toBe("env");
  });

  it("config file wins over default", async () => {
    const fs = makeFs(new Map([[CONFIG_PATH, "myns"]]));
    const r = new NamespaceResolver(fs, new FakeEnv("/home/u", "/cwd"));
    const result = await r.resolve(undefined);
    expect(result.namespace).toBe("myns");
    expect(result.source).toBe("config");
  });

  it("rejects invalid namespace from any source", async () => {
    const r = new NamespaceResolver(makeFs(), new FakeEnv("/home/u", "/cwd"));
    await expect(r.resolve("BAD_NS")).rejects.toThrow(/Invalid namespace/);
  });

  it("handles empty/whitespace flag as undefined", async () => {
    const r = new NamespaceResolver(makeFs(), new FakeEnv("/home/u", "/cwd"));
    const result = await r.resolve("   ");
    expect(result.source).toBe("default");
  });

  it("handles empty/whitespace env as absent", async () => {
    const env = new FakeEnv("/home/u", "/cwd", { AW_NAMESPACE: "   " });
    const r = new NamespaceResolver(makeFs(), env);
    const result = await r.resolve(undefined);
    expect(result.source).toBe("default");
  });

  it("auto-detects namespace from workspace cwd containing .workflow/sessions/", async () => {
    const dirs = new Map<string, DirEntry[]>([
      [
        "/cwd",
        [
          { name: ".workflow", path: "/cwd/.workflow", type: "dir" },
          { name: ".git", path: "/cwd/.git", type: "dir" },
          { name: "src", path: "/cwd/src", type: "dir" },
        ],
      ],
      ["/cwd/.workflow/sessions", []],
    ]);
    const fs = makeFs(new Map(), dirs);
    const r = new NamespaceResolver(fs, new FakeEnv("/home/u", "/cwd"));
    const result = await r.resolve(undefined);
    expect(result.namespace).toBe("workflow");
    expect(result.source).toBe("workspace");
  });

  it("ignores .git/ in workspace detect (no sessions/ subdir)", async () => {
    const dirs = new Map<string, DirEntry[]>([
      ["/cwd", [{ name: ".git", path: "/cwd/.git", type: "dir" }]],
    ]);
    const fs = makeFs(new Map(), dirs);
    const r = new NamespaceResolver(fs, new FakeEnv("/home/u", "/cwd"));
    const result = await r.resolve(undefined);
    expect(result.source).toBe("default");
  });

  it("fails typed when multiple canonical namespace markers share the nearest level", async () => {
    const dirs = new Map<string, DirEntry[]>([
      [
        "/cwd",
        [
          { name: ".workflow", path: "/cwd/.workflow", type: "dir" },
          { name: ".other", path: "/cwd/.other", type: "dir" },
        ],
      ],
      ["/cwd/.workflow/sessions", []],
      ["/cwd/.other/sessions", []],
    ]);
    const fs = makeFs(new Map(), dirs);
    const r = new NamespaceResolver(fs, new FakeEnv("/home/u", "/cwd"));
    await expect(r.resolveDirectory(undefined)).rejects.toMatchObject({
      code: "WORKLINE_NAMESPACE_AMBIGUOUS",
      root: "/cwd",
      namespaces: ["other", "workflow"],
    });
  });

  it("workspace auto-detect wins over user config (locality > preference)", async () => {
    const dirs = new Map<string, DirEntry[]>([
      ["/cwd", [{ name: ".workflow", path: "/cwd/.workflow", type: "dir" }]],
      ["/cwd/.workflow/sessions", []],
    ]);
    const fs = makeFs(new Map([[CONFIG_PATH, "configns"]]), dirs);
    const r = new NamespaceResolver(fs, new FakeEnv("/home/u", "/cwd"));
    const result = await r.resolve(undefined);
    expect(result.namespace).toBe("workflow");
    expect(result.source).toBe("workspace");
  });

  it("user config used when workspace cannot be determined (e.g., from $HOME)", async () => {
    const dirs = new Map<string, DirEntry[]>([
      ["/cwd", [{ name: "regular", path: "/cwd/regular", type: "dir" }]],
    ]);
    const fs = makeFs(new Map([[CONFIG_PATH, "fallbackns"]]), dirs);
    const r = new NamespaceResolver(fs, new FakeEnv("/home/u", "/cwd"));
    const result = await r.resolve(undefined);
    expect(result.namespace).toBe("fallbackns");
    expect(result.source).toBe("config");
  });

  it("handles unreadable cwd gracefully (returns default)", async () => {
    const fs = makeFs(); // empty dirs map → list() throws
    const r = new NamespaceResolver(fs, new FakeEnv("/home/u", "/cwd"));
    const result = await r.resolve(undefined);
    expect(result.source).toBe("default");
  });

  it("auto-detects any valid namespace with a sessions directory", async () => {
    const dirs = new Map<string, DirEntry[]>([
      ["/cwd", [{ name: ".legacy", path: "/cwd/.legacy", type: "dir" }]],
      ["/cwd/.legacy/sessions", []],
    ]);
    const fs = makeFs(new Map(), dirs);
    const r = new NamespaceResolver(fs, new FakeEnv("/home/u", "/cwd"));
    const result = await r.resolve(undefined);
    expect(result.source).toBe("workspace");
    expect(result.namespace).toBe("legacy");
  });

  it("uses the nearest ancestor marker as the shared Workline root", async () => {
    const fs = makeFs(
      new Map(),
      new Map([
        ["/repo", [{ name: ".workflow", path: "/repo/.workflow", type: "dir" }]],
        ["/repo/.workflow/sessions", []],
        ["/repo/packages/app/src", []],
      ]),
    );
    const r = new NamespaceResolver(fs, new FakeEnv("/home/u", "/repo/packages/app/src"));
    await expect(r.resolveDirectory(undefined)).resolves.toEqual({
      root: "/repo",
      namespace: "workflow",
      namespaceSource: "workspace",
      materialized: true,
    });
  });

  it("keeps the exact invoked cwd as an implicit root when no marker exists", async () => {
    const r = new NamespaceResolver(makeFs(), new FakeEnv("/home/u", "/plain/nested"));
    await expect(r.resolveDirectory(undefined)).resolves.toEqual({
      root: "/plain/nested",
      namespace: "workflow",
      namespaceSource: "default",
      materialized: false,
    });
  });

  it("honours an explicit namespace without silently selecting a neighbouring marker", async () => {
    const fs = makeFs(
      new Map(),
      new Map([
        ["/cwd", [{ name: ".workflow", path: "/cwd/.workflow", type: "dir" }]],
        ["/cwd/.workflow/sessions", []],
      ]),
    );
    const r = new NamespaceResolver(fs, new FakeEnv("/home/u", "/cwd"));
    await expect(r.resolveDirectory("other")).resolves.toEqual({
      root: "/cwd",
      namespace: "other",
      namespaceSource: "flag",
      materialized: false,
    });
  });

  it("honours AW_NAMESPACE at the closest matching marker", async () => {
    const fs = makeFs(
      new Map(),
      new Map([
        [
          "/repo",
          [
            { name: ".workflow", path: "/repo/.workflow", type: "dir" },
            { name: ".team", path: "/repo/.team", type: "dir" },
          ],
        ],
        ["/repo/.workflow/sessions", []],
        ["/repo/.team/sessions", []],
        ["/repo/packages/app", []],
      ]),
    );
    const r = new NamespaceResolver(
      fs,
      new FakeEnv("/home/u", "/repo/packages/app", { AW_NAMESPACE: "team" }),
    );
    await expect(r.resolveDirectory(undefined)).resolves.toEqual({
      root: "/repo",
      namespace: "team",
      namespaceSource: "env",
      materialized: true,
    });
  });
});
