import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROFILE,
  ENV_VAR_PROFILE,
  resolveProfile,
  validateProfile,
} from "../../src/application/profile/profile-service.js";
import type { EnvPort } from "../../src/ports/env.js";
import type { DirEntry, FileStat, FileSystemPort } from "../../src/ports/file-system.js";

class FakeFs implements FileSystemPort {
  constructor(public files: Map<string, string> = new Map()) {}
  async readText(p: string): Promise<string> {
    const v = this.files.get(p);
    if (v === undefined) throw new Error(`ENOENT: ${p}`);
    return v;
  }
  async writeText(p: string, c: string): Promise<void> {
    this.files.set(p, c);
  }
  async writeTextExclusive(p: string, c: string): Promise<{ created: boolean }> {
    if (this.files.has(p)) return { created: false };
    this.files.set(p, c);
    return { created: true };
  }
  async remove(p: string): Promise<void> {
    this.files.delete(p);
  }
  async exists(p: string): Promise<boolean> {
    return this.files.has(p);
  }
  async list(): Promise<DirEntry[]> {
    return [];
  }
  async mkdirp(): Promise<void> {}
  async stat(): Promise<FileStat> {
    return { mtime: new Date(0), size: 0, type: "file" };
  }
}

class FakeEnv implements EnvPort {
  constructor(
    private vars: Record<string, string> = {},
    private home = "/home/u",
    private workdir = "/cwd",
  ) {}
  get(name: string): string | undefined {
    return this.vars[name];
  }
  homeDir(): string {
    return this.home;
  }
  cwd(): string {
    return this.workdir;
  }
}

const VALID_PROFILE_JSON = JSON.stringify({
  namespace: "acme",
  company: "ACME Inc",
  claude_md_block: "ACME-PROJECT",
  mcp_databases: [{ alias: "acme-cert", host: "10.0.0.1", port: 5432, database: "acme_cert" }],
  lexicon_path: "profiles/lexico-acme.md",
  examples_path: "profiles/examples-acme.md",
  migrate_legacy_rules: [{ from: "/old:cmd", to: "/agent-workflow:cmd", scope: "command" }],
  custom_anchors: [{ anchor: "acme:rule-1", target: "doctrine/acme-rule-1.md" }],
});

describe("resolveProfile — cascade", () => {
  it("resolves layer 1: --profile flag (absolute path)", async () => {
    const path = "/explicit/profile.json";
    const fs = new FakeFs(new Map([[path, VALID_PROFILE_JSON]]));
    const env = new FakeEnv();
    const result = await resolveProfile(fs, env, { flagPath: path });
    if ("code" in result) throw new Error(`unexpected: ${result.message}`);
    expect(result.source).toBe("flag");
    expect(result.path).toBe(path);
    expect(result.profile.namespace).toBe("acme");
  });

  it("resolves layer 1: --profile flag (relative path absolutized via cwd)", async () => {
    const fs = new FakeFs(new Map([["/cwd/rel/profile.json", VALID_PROFILE_JSON]]));
    const env = new FakeEnv({}, "/home/u", "/cwd");
    const result = await resolveProfile(fs, env, { flagPath: "rel/profile.json" });
    if ("code" in result) throw new Error(`unexpected: ${result.message}`);
    expect(result.source).toBe("flag");
    expect(result.path).toBe("/cwd/rel/profile.json");
  });

  it("resolves layer 2: AW_PROFILE env var", async () => {
    const path = "/env/profile.json";
    const fs = new FakeFs(new Map([[path, VALID_PROFILE_JSON]]));
    const env = new FakeEnv({ [ENV_VAR_PROFILE]: path });
    const result = await resolveProfile(fs, env);
    if ("code" in result) throw new Error(`unexpected: ${result.message}`);
    expect(result.source).toBe("env");
    expect(result.path).toBe(path);
  });

  it("resolves layer 3: ~/.config/agent-workflow/profile.json", async () => {
    const userPath = "/home/u/.config/agent-workflow/profile.json";
    const fs = new FakeFs(new Map([[userPath, VALID_PROFILE_JSON]]));
    const env = new FakeEnv();
    const result = await resolveProfile(fs, env);
    if ("code" in result) throw new Error(`unexpected: ${result.message}`);
    expect(result.source).toBe("user-config");
    expect(result.path).toBe(userPath);
  });

  it("resolves layer 4: <cwd>/.agent-workflow/profile.json", async () => {
    const wsPath = "/cwd/.agent-workflow/profile.json";
    const fs = new FakeFs(new Map([[wsPath, VALID_PROFILE_JSON]]));
    const env = new FakeEnv();
    const result = await resolveProfile(fs, env);
    if ("code" in result) throw new Error(`unexpected: ${result.message}`);
    expect(result.source).toBe("workspace");
    expect(result.path).toBe(wsPath);
  });

  it("resolves layer 4 with custom workspace namespace: <cwd>/.qtc/profile.json", async () => {
    const wsPath = "/cwd/.qtc/profile.json";
    const fs = new FakeFs(new Map([[wsPath, VALID_PROFILE_JSON]]));
    const env = new FakeEnv();
    const result = await resolveProfile(fs, env, { workspaceNamespace: "qtc" });
    if ("code" in result) throw new Error(`unexpected: ${result.message}`);
    expect(result.source).toBe("workspace");
    expect(result.path).toBe(wsPath);
  });

  it("resolves layer 5: defaults to DEFAULT_PROFILE when nothing exists", async () => {
    const fs = new FakeFs();
    const env = new FakeEnv();
    const result = await resolveProfile(fs, env);
    if ("code" in result) throw new Error(`unexpected: ${result.message}`);
    expect(result.source).toBe("default");
    expect(result.path).toBeNull();
    expect(result.profile.namespace).toBe(DEFAULT_PROFILE.namespace);
    expect(result.profile.claude_md_block).toBe("AW-PROJECT");
  });

  it("flag wins over env wins over user-config wins over workspace", async () => {
    const flagPath = "/flag/profile.json";
    const envPath = "/env/profile.json";
    const userPath = "/home/u/.config/agent-workflow/profile.json";
    const wsPath = "/cwd/.agent-workflow/profile.json";
    const flagJson = JSON.stringify({ ...JSON.parse(VALID_PROFILE_JSON), company: "FLAG" });
    const envJson = JSON.stringify({ ...JSON.parse(VALID_PROFILE_JSON), company: "ENV" });
    const userJson = JSON.stringify({ ...JSON.parse(VALID_PROFILE_JSON), company: "USER" });
    const wsJson = JSON.stringify({ ...JSON.parse(VALID_PROFILE_JSON), company: "WS" });
    const fs = new FakeFs(
      new Map([
        [flagPath, flagJson],
        [envPath, envJson],
        [userPath, userJson],
        [wsPath, wsJson],
      ]),
    );

    // 1. flag wins
    let env: EnvPort = new FakeEnv({ [ENV_VAR_PROFILE]: envPath });
    let result = await resolveProfile(fs, env, { flagPath });
    if ("code" in result) throw new Error("unexpected");
    expect(result.profile.company).toBe("FLAG");

    // 2. env wins when no flag
    env = new FakeEnv({ [ENV_VAR_PROFILE]: envPath });
    result = await resolveProfile(fs, env);
    if ("code" in result) throw new Error("unexpected");
    expect(result.profile.company).toBe("ENV");

    // 3. user-config wins when no flag/env
    env = new FakeEnv();
    result = await resolveProfile(fs, env);
    if ("code" in result) throw new Error("unexpected");
    expect(result.profile.company).toBe("USER");

    // 4. workspace wins when only it exists
    fs.files.delete(userPath);
    result = await resolveProfile(fs, env);
    if ("code" in result) throw new Error("unexpected");
    expect(result.profile.company).toBe("WS");
  });

  it("flag path missing → PROFILE_NOT_FOUND", async () => {
    const fs = new FakeFs();
    const env = new FakeEnv();
    const result = await resolveProfile(fs, env, { flagPath: "/missing/profile.json" });
    if (!("code" in result)) throw new Error("expected error");
    expect(result.code).toBe("PROFILE_NOT_FOUND");
    expect(result.path).toBe("/missing/profile.json");
  });

  it("env path missing → PROFILE_NOT_FOUND", async () => {
    const fs = new FakeFs();
    const env = new FakeEnv({ [ENV_VAR_PROFILE]: "/missing/profile.json" });
    const result = await resolveProfile(fs, env);
    if (!("code" in result)) throw new Error("expected error");
    expect(result.code).toBe("PROFILE_NOT_FOUND");
  });

  it("invalid JSON → PROFILE_INVALID_JSON", async () => {
    const path = "/p/profile.json";
    const fs = new FakeFs(new Map([[path, "{not valid json"]]));
    const env = new FakeEnv();
    const result = await resolveProfile(fs, env, { flagPath: path });
    if (!("code" in result)) throw new Error("expected error");
    expect(result.code).toBe("PROFILE_INVALID_JSON");
  });
});

describe("validateProfile — schema", () => {
  it("accepts a minimal valid profile (empty arrays + null paths)", () => {
    const r = validateProfile({
      namespace: "x",
      company: "X",
      claude_md_block: "X",
      mcp_databases: [],
      lexicon_path: null,
      examples_path: null,
      migrate_legacy_rules: [],
      custom_anchors: [],
    });
    if ("code" in r) throw new Error(r.message);
    expect(r.namespace).toBe("x");
  });

  it("rejects non-object root", () => {
    const r = validateProfile("string");
    if (!("code" in r)) throw new Error("expected error");
    expect(r.code).toBe("PROFILE_INVALID_SCHEMA");
    expect(r.field).toBe("root");
  });

  it("rejects invalid namespace (non-kebab)", () => {
    const r = validateProfile({
      namespace: "ACME",
      company: "ACME",
      claude_md_block: "ACME",
      mcp_databases: [],
      lexicon_path: null,
      examples_path: null,
      migrate_legacy_rules: [],
      custom_anchors: [],
    });
    if (!("code" in r)) throw new Error("expected error");
    expect(r.field).toBe("namespace");
  });

  it("rejects invalid claude_md_block (lowercase)", () => {
    const r = validateProfile({
      namespace: "x",
      company: "X",
      claude_md_block: "lowercase",
      mcp_databases: [],
      lexicon_path: null,
      examples_path: null,
      migrate_legacy_rules: [],
      custom_anchors: [],
    });
    if (!("code" in r)) throw new Error("expected error");
    expect(r.field).toBe("claude_md_block");
  });

  it("rejects mcp_databases with bad port", () => {
    const r = validateProfile({
      namespace: "x",
      company: "X",
      claude_md_block: "X",
      mcp_databases: [{ alias: "a", host: "h", port: 99999, database: "d" }],
      lexicon_path: null,
      examples_path: null,
      migrate_legacy_rules: [],
      custom_anchors: [],
    });
    if (!("code" in r)) throw new Error("expected error");
    expect(r.field).toBe("mcp_databases[0].port");
  });

  it("rejects migrate_legacy_rules with bad scope", () => {
    const r = validateProfile({
      namespace: "x",
      company: "X",
      claude_md_block: "X",
      mcp_databases: [],
      lexicon_path: null,
      examples_path: null,
      migrate_legacy_rules: [{ from: "a", to: "b", scope: "invalid" }],
      custom_anchors: [],
    });
    if (!("code" in r)) throw new Error("expected error");
    expect(r.field).toBe("migrate_legacy_rules[0].scope");
  });

  it("rejects custom_anchors missing target", () => {
    const r = validateProfile({
      namespace: "x",
      company: "X",
      claude_md_block: "X",
      mcp_databases: [],
      lexicon_path: null,
      examples_path: null,
      migrate_legacy_rules: [],
      custom_anchors: [{ anchor: "x" }],
    });
    if (!("code" in r)) throw new Error("expected error");
    expect(r.field).toBe("custom_anchors[0].target");
  });

  it("accepts mcp_databases with optional schema field", () => {
    const r = validateProfile({
      namespace: "x",
      company: "X",
      claude_md_block: "X",
      mcp_databases: [{ alias: "a", host: "h", port: 5432, database: "d", schema: "public" }],
      lexicon_path: null,
      examples_path: null,
      migrate_legacy_rules: [],
      custom_anchors: [],
    });
    if ("code" in r) throw new Error(r.message);
    expect(r.mcp_databases[0]?.schema).toBe("public");
  });
});
