import { describe, expect, it } from "vitest";
import { runCodeScan } from "../../src/application/code-scan-service.js";
import { PathsService } from "../../src/application/paths-service.js";
import type { EnvPort } from "../../src/ports/env.js";
import type { DirEntry, FileStat, FileSystemPort } from "../../src/ports/file-system.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";

class FakeEnv implements EnvPort {
  get() {
    return undefined;
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
  async writeText(): Promise<void> {}
  async exists(p: string) {
    return this.files.has(p) || this.dirs.has(p);
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

const ns = normalizeNamespace("workflow");
const paths = new PathsService(ns, "/home/u", "/cwd");

function makeFs(setup: { files?: Record<string, string>; dirs?: Record<string, DirEntry[]> }) {
  return new FakeFs(
    new Map(Object.entries(setup.files ?? {})),
    new Map(Object.entries(setup.dirs ?? {})),
  );
}

describe("runCodeScan", () => {
  it("returns root_not_found when root does not exist", async () => {
    const fs = makeFs({});
    const result = await runCodeScan(fs, new FakeEnv(), paths, { root: "/does-not-exist" });
    if ("error" in result) {
      expect(result.error).toBe("root_not_found");
      expect(result.root).toBe("/does-not-exist");
    } else {
      throw new Error("expected error result");
    }
  });

  it("returns 0 matches when project has no flagged content", async () => {
    const fs = makeFs({
      dirs: {
        "/cwd/proj": [{ name: "main.ts", path: "/cwd/proj/main.ts", type: "file" }],
      },
      files: {
        "/cwd/proj/main.ts": "function add(a: number, b: number) {\n  return a + b;\n}\n",
      },
    });
    const result = await runCodeScan(fs, new FakeEnv(), paths, { root: "/cwd/proj" });
    if ("error" in result) throw new Error("unexpected error");
    expect(result.total_matches).toBe(0);
    expect(result.by_severity).toEqual({ alta: 0, media: 0, baja: 0 });
  });

  it("flags hardcoded password as severity alta", async () => {
    const fs = makeFs({
      dirs: {
        "/cwd/proj": [{ name: "config.ts", path: "/cwd/proj/config.ts", type: "file" }],
      },
      files: {
        "/cwd/proj/config.ts": 'const password = "secret123abc";\n',
      },
    });
    const result = await runCodeScan(fs, new FakeEnv(), paths, { root: "/cwd/proj" });
    if ("error" in result) throw new Error("unexpected error");
    expect(result.total_matches).toBe(1);
    expect(result.matches[0]?.pattern_id).toBe("hardcoded-secret");
    expect(result.matches[0]?.severity).toBe("alta");
    expect(result.by_severity.alta).toBe(1);
  });

  it("flags TODO comment as severity baja", async () => {
    const fs = makeFs({
      dirs: {
        "/cwd/proj": [{ name: "main.ts", path: "/cwd/proj/main.ts", type: "file" }],
      },
      files: {
        "/cwd/proj/main.ts": "// TODO: refactor this\nfunction noop() {}\n",
      },
    });
    const result = await runCodeScan(fs, new FakeEnv(), paths, { root: "/cwd/proj" });
    if ("error" in result) throw new Error("unexpected error");
    expect(result.total_matches).toBe(1);
    expect(result.matches[0]?.pattern_id).toBe("todo-fixme");
    expect(result.matches[0]?.severity).toBe("baja");
  });

  it("flags localhost URL as severity media", async () => {
    const fs = makeFs({
      dirs: {
        "/cwd/proj": [{ name: "config.ts", path: "/cwd/proj/config.ts", type: "file" }],
      },
      files: {
        "/cwd/proj/config.ts": 'const API = "http://localhost:8080";\n',
      },
    });
    const result = await runCodeScan(fs, new FakeEnv(), paths, { root: "/cwd/proj" });
    if ("error" in result) throw new Error("unexpected error");
    expect(result.total_matches).toBeGreaterThanOrEqual(1);
    const localhostMatch = result.matches.find((m) => m.pattern_id === "localhost");
    expect(localhostMatch?.severity).toBe("media");
  });

  it("flags console.log as severity baja", async () => {
    const fs = makeFs({
      dirs: {
        "/cwd/proj": [{ name: "main.ts", path: "/cwd/proj/main.ts", type: "file" }],
      },
      files: {
        "/cwd/proj/main.ts": 'console.log("hi");\n',
      },
    });
    const result = await runCodeScan(fs, new FakeEnv(), paths, { root: "/cwd/proj" });
    if ("error" in result) throw new Error("unexpected error");
    const consoleMatch = result.matches.find((m) => m.pattern_id === "console-log");
    expect(consoleMatch?.severity).toBe("baja");
  });

  it("excludes node_modules and dist by default", async () => {
    const fs = makeFs({
      dirs: {
        "/cwd/proj": [
          { name: "node_modules", path: "/cwd/proj/node_modules", type: "dir" },
          { name: "dist", path: "/cwd/proj/dist", type: "dir" },
          { name: "main.ts", path: "/cwd/proj/main.ts", type: "file" },
        ],
        "/cwd/proj/node_modules": [
          { name: "leak.ts", path: "/cwd/proj/node_modules/leak.ts", type: "file" },
        ],
        "/cwd/proj/dist": [{ name: "leak.ts", path: "/cwd/proj/dist/leak.ts", type: "file" }],
      },
      files: {
        "/cwd/proj/main.ts": 'console.log("ok");\n',
        "/cwd/proj/node_modules/leak.ts": 'const password = "leakedfromnodemodules123";\n',
        "/cwd/proj/dist/leak.ts": 'const password = "leakedfromdist123";\n',
      },
    });
    const result = await runCodeScan(fs, new FakeEnv(), paths, { root: "/cwd/proj" });
    if ("error" in result) throw new Error("unexpected error");
    // Only the main.ts console.log match should appear; the node_modules/dist secrets are excluded.
    const secretsFound = result.matches.filter((m) => m.pattern_id === "hardcoded-secret");
    expect(secretsFound).toHaveLength(0);
  });

  it("excludes .workflow namespace dir by default (per paths.namespace)", async () => {
    const fs = makeFs({
      dirs: {
        "/cwd/proj": [
          { name: ".workflow", path: "/cwd/proj/.workflow", type: "dir" },
          { name: "main.ts", path: "/cwd/proj/main.ts", type: "file" },
        ],
        "/cwd/proj/.workflow": [
          { name: "leak.ts", path: "/cwd/proj/.workflow/leak.ts", type: "file" },
        ],
      },
      files: {
        "/cwd/proj/main.ts": "function noop() {}\n",
        "/cwd/proj/.workflow/leak.ts": 'const password = "leakedfromworkflow123";\n',
      },
    });
    const result = await runCodeScan(fs, new FakeEnv(), paths, { root: "/cwd/proj" });
    if ("error" in result) throw new Error("unexpected error");
    expect(result.matches.filter((m) => m.pattern_id === "hardcoded-secret")).toHaveLength(0);
  });

  it("respects maxPerPattern cap", async () => {
    const fs = makeFs({
      dirs: {
        "/cwd/proj": [{ name: "main.ts", path: "/cwd/proj/main.ts", type: "file" }],
      },
      files: {
        "/cwd/proj/main.ts": "// TODO 1\n// TODO 2\n// TODO 3\n// TODO 4\n",
      },
    });
    const result = await runCodeScan(fs, new FakeEnv(), paths, {
      root: "/cwd/proj",
      maxPerPattern: 2,
    });
    if ("error" in result) throw new Error("unexpected error");
    const todos = result.matches.filter((m) => m.pattern_id === "todo-fixme");
    expect(todos.length).toBeLessThanOrEqual(2);
    expect(result.counts["todo-fixme"]).toBeLessThanOrEqual(2);
  });

  it("uses inlinePatterns when provided", async () => {
    const fs = makeFs({
      dirs: {
        "/cwd/proj": [{ name: "main.ts", path: "/cwd/proj/main.ts", type: "file" }],
      },
      files: {
        "/cwd/proj/main.ts": "let x = MAGIC_TOKEN_42;\n",
      },
    });
    const result = await runCodeScan(fs, new FakeEnv(), paths, {
      root: "/cwd/proj",
      inlinePatterns: [
        {
          id: "magic-token",
          regex: "MAGIC_TOKEN_\\d+",
          severity: "alta",
          recommendation: "remove magic token",
        },
      ],
    });
    if ("error" in result) throw new Error("unexpected error");
    expect(result.total_matches).toBe(1);
    expect(result.matches[0]?.pattern_id).toBe("magic-token");
    expect(result.patterns_used).toEqual(["magic-token"]);
  });

  it("only scans configured extensions (skips .md)", async () => {
    const fs = makeFs({
      dirs: {
        "/cwd/proj": [
          { name: "main.ts", path: "/cwd/proj/main.ts", type: "file" },
          { name: "README.md", path: "/cwd/proj/README.md", type: "file" },
        ],
      },
      files: {
        "/cwd/proj/main.ts": "function noop() {}\n",
        "/cwd/proj/README.md": "TODO: write docs\n",
      },
    });
    const result = await runCodeScan(fs, new FakeEnv(), paths, { root: "/cwd/proj" });
    if ("error" in result) throw new Error("unexpected error");
    // README.md is not in default extensions; TODO inside it should be ignored.
    const todos = result.matches.filter((m) => m.pattern_id === "todo-fixme");
    expect(todos).toHaveLength(0);
  });
});
