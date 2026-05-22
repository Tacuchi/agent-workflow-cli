import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROFILE,
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

const QTC_PROFILE = {
  namespace: "qtc",
  company: "QuetalCompra",
  claude_md_block: "QTC-PROJECT",
  mcp_databases: [
    {
      alias: "qtc-cert",
      host: "10.0.0.10",
      port: 5432,
      database: "qtc_cert",
      schema: "public",
    },
    { alias: "qtc-prod", host: "10.0.0.11", port: 5432, database: "qtc_prod" },
  ],
  lexicon_path: "profiles/lexico-qtc.md",
  examples_path: "profiles/examples-qtc.md",
  migrate_legacy_rules: [
    { from: ".claude/sessions", to: ".workflow/sessions", scope: "anchor" },
    { from: "QTC-WORKFLOW", to: "QTC-PROJECT", scope: "anchor" },
    { from: "OBJETIVO.md", to: "OBJECTIVE.md", scope: "anchor" },
  ],
  custom_anchors: [
    {
      anchor: "qtc:super-admin-bypass",
      target: "profiles/anchors/qtc-super-admin-bypass.md",
    },
  ],
};

const ACME_PROFILE = {
  namespace: "acme",
  company: "ACME Inc",
  claude_md_block: "ACME-PROJECT",
  mcp_databases: [
    {
      alias: "acme-staging",
      host: "db-staging.acme.internal",
      port: 5432,
      database: "acme_staging",
    },
  ],
  lexicon_path: null,
  examples_path: null,
  migrate_legacy_rules: [],
  custom_anchors: [{ anchor: "acme:rule-1", target: "doctrine/acme-rule-1.md" }],
};

describe("profile parametrization snapshots (T2.9 golden coverage)", () => {
  it("default (empty) profile shape matches DEFAULT_PROFILE", async () => {
    const fs = new FakeFs();
    const env = new FakeEnv();
    const result = await resolveProfile(fs, env);
    if ("code" in result) throw new Error(result.message);
    expect(result.source).toBe("default");
    expect(result.profile).toMatchInlineSnapshot(`
      {
        "claude_md_block": "AW-PROJECT",
        "company": "agent-workflow",
        "custom_anchors": [],
        "examples_path": null,
        "lexicon_path": null,
        "mcp_databases": [],
        "migrate_legacy_rules": [],
        "namespace": "agent-workflow",
      }
    `);
  });

  it("QTC profile preserves all 8 fields with concrete values", () => {
    const result = validateProfile(QTC_PROFILE);
    if ("code" in result) throw new Error(result.message);
    expect(result.namespace).toBe("qtc");
    expect(result.company).toBe("QuetalCompra");
    expect(result.claude_md_block).toBe("QTC-PROJECT");
    expect(result.mcp_databases.length).toBe(2);
    expect(result.mcp_databases[0]?.alias).toBe("qtc-cert");
    expect(result.lexicon_path).toBe("profiles/lexico-qtc.md");
    expect(result.examples_path).toBe("profiles/examples-qtc.md");
    expect(result.migrate_legacy_rules.length).toBe(3);
    expect(result.custom_anchors.length).toBe(1);
  });

  it("ACME profile (hypothetical multi-empresa) validates and rounds-trip", async () => {
    const fs = new FakeFs(new Map([["/cwd/.acme/profile.json", JSON.stringify(ACME_PROFILE)]]));
    const env = new FakeEnv();
    const result = await resolveProfile(fs, env, { workspaceNamespace: "acme" });
    if ("code" in result) throw new Error(result.message);
    expect(result.source).toBe("workspace");
    expect(result.profile.namespace).toBe("acme");
    expect(result.profile.claude_md_block).toBe("ACME-PROJECT");
    expect(result.profile.mcp_databases.length).toBe(1);
    expect(result.profile.migrate_legacy_rules.length).toBe(0);
    expect(result.profile.custom_anchors[0]?.anchor).toBe("acme:rule-1");
  });

  it("DEFAULT_PROFILE is read-only (frozen)", () => {
    expect(() => {
      // @ts-expect-error — attempting to mutate to verify Object.freeze
      DEFAULT_PROFILE.namespace = "mutated";
    }).toThrow();
  });

  it("cloned default does not share array references with DEFAULT_PROFILE", async () => {
    const fs = new FakeFs();
    const env = new FakeEnv();
    const r1 = await resolveProfile(fs, env);
    const r2 = await resolveProfile(fs, env);
    if ("code" in r1 || "code" in r2) throw new Error("unexpected error");
    expect(r1.profile.mcp_databases).not.toBe(r2.profile.mcp_databases);
    expect(r1.profile.mcp_databases).not.toBe(DEFAULT_PROFILE.mcp_databases);
  });
});
