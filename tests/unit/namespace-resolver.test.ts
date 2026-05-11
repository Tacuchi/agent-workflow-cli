import { describe, expect, it } from "vitest";
import type { EnvPort } from "../../src/ports/env.js";
import type { DirEntry, FileStat, FileSystemPort } from "../../src/ports/file-system.js";
import { NamespaceResolver } from "../../src/runtime/namespace-resolver.js";

class FakeEnv implements EnvPort {
  constructor(private vars: Record<string, string | undefined> = {}) {}
  get(name: string) {
    return this.vars[name];
  }
  homeDir() {
    return "/home/u";
  }
  cwd() {
    return "/cwd";
  }
}

class FakeFs implements FileSystemPort {
  constructor(
    private files: Map<string, string> = new Map(),
    private dirs: Map<string, DirEntry[]> = new Map(),
  ) {}
  async readText(p: string) {
    const v = this.files.get(p);
    if (v === undefined) throw new Error(`ENOENT: ${p}`);
    return v;
  }
  async writeText(): Promise<void> {
    throw new Error("nyi");
  }
  async exists(p: string) {
    if (this.files.has(p)) return true;
    if (this.dirs.has(p)) return true;
    return false;
  }
  async list(p: string): Promise<DirEntry[]> {
    const v = this.dirs.get(p);
    if (v === undefined) throw new Error(`ENOENT: ${p}`);
    return v;
  }
  async mkdirp(): Promise<void> {}
  async stat(): Promise<FileStat> {
    throw new Error("nyi");
  }
}

describe("NamespaceResolver", () => {
  const CONFIG_PATH = "/home/u/.config/agent-workflow/namespace";

  it("returns default 'workflow' when no flag/env/config", async () => {
    const r = new NamespaceResolver(new FakeFs(), new FakeEnv());
    const result = await r.resolve(undefined);
    expect(result.namespace).toBe("workflow");
    expect(result.source).toBe("default");
  });

  it("flag wins over env", async () => {
    const env = new FakeEnv({ AW_NAMESPACE: "envwin" });
    const r = new NamespaceResolver(new FakeFs(), env);
    const result = await r.resolve("flagwin");
    expect(result.namespace).toBe("flagwin");
    expect(result.source).toBe("flag");
  });

  it("env wins over config file", async () => {
    const env = new FakeEnv({ AW_NAMESPACE: "envns" });
    const fs = new FakeFs(new Map([[CONFIG_PATH, "configns\n"]]));
    const r = new NamespaceResolver(fs, env);
    const result = await r.resolve(undefined);
    expect(result.namespace).toBe("envns");
    expect(result.source).toBe("env");
  });

  it("config file wins over default", async () => {
    const fs = new FakeFs(new Map([[CONFIG_PATH, "myns"]]));
    const r = new NamespaceResolver(fs, new FakeEnv());
    const result = await r.resolve(undefined);
    expect(result.namespace).toBe("myns");
    expect(result.source).toBe("config");
  });

  it("rejects invalid namespace from any source", async () => {
    const r = new NamespaceResolver(new FakeFs(), new FakeEnv());
    await expect(r.resolve("BAD_NS")).rejects.toThrow(/Invalid namespace/);
  });

  it("handles empty/whitespace flag as undefined", async () => {
    const r = new NamespaceResolver(new FakeFs(), new FakeEnv());
    const result = await r.resolve("   ");
    expect(result.source).toBe("default");
  });

  it("handles empty/whitespace env as absent", async () => {
    const env = new FakeEnv({ AW_NAMESPACE: "   " });
    const r = new NamespaceResolver(new FakeFs(), env);
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
    const fs = new FakeFs(new Map(), dirs);
    const r = new NamespaceResolver(fs, new FakeEnv());
    const result = await r.resolve(undefined);
    expect(result.namespace).toBe("workflow");
    expect(result.source).toBe("workspace");
  });

  it("ignores .git/ in workspace detect (no sessions/ subdir)", async () => {
    const dirs = new Map<string, DirEntry[]>([
      ["/cwd", [{ name: ".git", path: "/cwd/.git", type: "dir" }]],
    ]);
    const fs = new FakeFs(new Map(), dirs);
    const r = new NamespaceResolver(fs, new FakeEnv());
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
    const fs = new FakeFs(new Map(), dirs);
    const r = new NamespaceResolver(fs, new FakeEnv());
    const result = await r.resolve(undefined);
    expect(result.source).toBe("default");
  });

  it("workspace auto-detect wins over user config (locality > preference)", async () => {
    const dirs = new Map<string, DirEntry[]>([
      ["/cwd", [{ name: ".workflow", path: "/cwd/.workflow", type: "dir" }]],
      ["/cwd/.workflow/sessions", []],
    ]);
    const fs = new FakeFs(new Map([[CONFIG_PATH, "configns"]]), dirs);
    const r = new NamespaceResolver(fs, new FakeEnv());
    const result = await r.resolve(undefined);
    expect(result.namespace).toBe("workflow");
    expect(result.source).toBe("workspace");
  });

  it("user config used when workspace cannot be determined (e.g., from $HOME)", async () => {
    const dirs = new Map<string, DirEntry[]>([
      ["/cwd", [{ name: "regular", path: "/cwd/regular", type: "dir" }]],
    ]);
    const fs = new FakeFs(new Map([[CONFIG_PATH, "fallbackns"]]), dirs);
    const r = new NamespaceResolver(fs, new FakeEnv());
    const result = await r.resolve(undefined);
    expect(result.namespace).toBe("fallbackns");
    expect(result.source).toBe("config");
  });

  it("handles unreadable cwd gracefully (returns default)", async () => {
    const fs = new FakeFs(); // empty dirs map → list() throws
    const r = new NamespaceResolver(fs, new FakeEnv());
    const result = await r.resolve(undefined);
    expect(result.source).toBe("default");
  });

  it("ignores legacy '.qtc/sessions/' in workspace autodetect (denylist)", async () => {
    const dirs = new Map<string, DirEntry[]>([
      ["/cwd", [{ name: ".qtc", path: "/cwd/.qtc", type: "dir" }]],
      ["/cwd/.qtc/sessions", []],
    ]);
    const fs = new FakeFs(new Map(), dirs);
    const r = new NamespaceResolver(fs, new FakeEnv());
    const result = await r.resolve(undefined);
    expect(result.namespace).toBe("workflow");
    expect(result.source).toBe("default");
  });

  it("legacy '.qtc/' denylist does not affect explicit --namespace qtc", async () => {
    const r = new NamespaceResolver(new FakeFs(), new FakeEnv());
    const result = await r.resolve("qtc");
    expect(result.namespace).toBe("qtc");
    expect(result.source).toBe("flag");
  });

  it("legacy '.qtc/' denylist does not affect AW_NAMESPACE=qtc env override", async () => {
    const env = new FakeEnv({ AW_NAMESPACE: "qtc" });
    const r = new NamespaceResolver(new FakeFs(), env);
    const result = await r.resolve(undefined);
    expect(result.namespace).toBe("qtc");
    expect(result.source).toBe("env");
  });

  it("legacy '.qtc/' denylist does not affect user-config = qtc", async () => {
    const fs = new FakeFs(new Map([[CONFIG_PATH, "qtc"]]));
    const r = new NamespaceResolver(fs, new FakeEnv());
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
    const fs = new FakeFs(new Map(), dirs);
    const r = new NamespaceResolver(fs, new FakeEnv());
    const result = await r.resolve(undefined);
    expect(result.namespace).toBe("workflow");
    expect(result.source).toBe("workspace");
  });
});
