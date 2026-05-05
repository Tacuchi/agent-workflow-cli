import { describe, expect, it } from "vitest";
import { NamespaceResolver } from "../../src/runtime/namespace-resolver.js";
import type { EnvPort } from "../../src/ports/env.js";
import type { DirEntry, FileStat, FileSystemPort } from "../../src/ports/file-system.js";

class FakeEnv implements EnvPort {
  constructor(private vars: Record<string, string | undefined> = {}) {}
  get(name: string) { return this.vars[name]; }
  homeDir() { return "/home/u"; }
  cwd() { return "/cwd"; }
}

class FakeFs implements FileSystemPort {
  constructor(private files: Map<string, string> = new Map()) {}
  async readText(p: string) {
    const v = this.files.get(p);
    if (v === undefined) throw new Error(`ENOENT: ${p}`);
    return v;
  }
  async writeText(): Promise<void> { throw new Error("nyi"); }
  async exists(p: string) { return this.files.has(p); }
  async list(): Promise<DirEntry[]> { return []; }
  async mkdirp(): Promise<void> {}
  async stat(): Promise<FileStat> { throw new Error("nyi"); }
}

describe("NamespaceResolver", () => {
  const CONFIG_PATH = "/home/u/.config/agent-workflow/namespace";

  it("returns default 'agent-workflow' when no flag/env/config", async () => {
    const r = new NamespaceResolver(new FakeFs(), new FakeEnv());
    const result = await r.resolve(undefined);
    expect(result.namespace).toBe("agent-workflow");
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
});
