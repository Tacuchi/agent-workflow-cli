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

  it("falls back to default when multiple namespace candidates match (ambiguous)", async () => {
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
    const result = await r.resolve(undefined);
    expect(result.source).toBe("default");
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

  it("ignores legacy '.qtc/sessions/' in workspace autodetect (denylist)", async () => {
    const dirs = new Map<string, DirEntry[]>([
      ["/cwd", [{ name: ".qtc", path: "/cwd/.qtc", type: "dir" }]],
      ["/cwd/.qtc/sessions", []],
    ]);
    const fs = makeFs(new Map(), dirs);
    const r = new NamespaceResolver(fs, new FakeEnv("/home/u", "/cwd"));
    const result = await r.resolve(undefined);
    expect(result.namespace).toBe("workflow");
    expect(result.source).toBe("default");
  });

  it("legacy '.qtc/' denylist does not affect explicit --namespace qtc", async () => {
    const r = new NamespaceResolver(makeFs(), new FakeEnv("/home/u", "/cwd"));
    const result = await r.resolve("qtc");
    expect(result.namespace).toBe("qtc");
    expect(result.source).toBe("flag");
  });

  it("legacy '.qtc/' denylist does not affect AW_NAMESPACE=qtc env override", async () => {
    const env = new FakeEnv("/home/u", "/cwd", { AW_NAMESPACE: "qtc" });
    const r = new NamespaceResolver(makeFs(), env);
    const result = await r.resolve(undefined);
    expect(result.namespace).toBe("qtc");
    expect(result.source).toBe("env");
  });

  it("legacy '.qtc/' denylist does not affect user-config = qtc", async () => {
    const fs = makeFs(new Map([[CONFIG_PATH, "qtc"]]));
    const r = new NamespaceResolver(fs, new FakeEnv("/home/u", "/cwd"));
    const result = await r.resolve(undefined);
    expect(result.namespace).toBe("qtc");
    expect(result.source).toBe("config");
  });

  it("'.qtc/' denylist preserves '.workflow/' detection when both present", async () => {
    const dirs = new Map<string, DirEntry[]>([
      [
        "/cwd",
        [
          { name: ".qtc", path: "/cwd/.qtc", type: "dir" },
          { name: ".workflow", path: "/cwd/.workflow", type: "dir" },
        ],
      ],
      ["/cwd/.qtc/sessions", []],
      ["/cwd/.workflow/sessions", []],
    ]);
    const fs = makeFs(new Map(), dirs);
    const r = new NamespaceResolver(fs, new FakeEnv("/home/u", "/cwd"));
    const result = await r.resolve(undefined);
    expect(result.namespace).toBe("workflow");
    expect(result.source).toBe("workspace");
  });
});
