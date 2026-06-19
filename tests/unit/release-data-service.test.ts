import { describe, expect, it } from "vitest";
import { PathsService } from "../../src/application/paths-service.js";
import {
  listSessionsForRelease,
  readSessionArtifacts,
} from "../../src/application/release-data-service.js";
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
  async stat(p: string): Promise<FileStat> {
    if (this.files.has(p)) {
      return {
        mtime: new Date("2026-01-01"),
        size: (this.files.get(p) ?? "").length,
        type: "file",
      };
    }
    return { mtime: new Date("2026-01-01"), size: 0, type: "dir" };
  }
}

const ns = normalizeNamespace("workflow");
const paths = new PathsService(ns, "/home/u", "/cwd");

function statusMd(state: "active" | "closed", phase: string): string {
  return `# Status\n\n- State: ${state}\n- Phase: ${phase}\n`;
}

describe("listSessionsForRelease", () => {
  it("returns empty array when sessions dir does not exist", async () => {
    const fs = new FakeFs(new Map(), new Map());
    const result = await listSessionsForRelease(fs, "/cwd", paths);
    expect(result).toEqual([]);
  });

  it("returns empty array when sessions dir exists but is empty", async () => {
    const fs = new FakeFs(new Map(), new Map([["/cwd/.workflow/sessions", []]]));
    const result = await listSessionsForRelease(fs, "/cwd", paths);
    expect(result).toEqual([]);
  });

  it("returns sessions sorted by code", async () => {
    const baseSessionsDir = "/cwd/.workflow/sessions";
    const fs = new FakeFs(
      new Map([
        [`${baseSessionsDir}/session001-dev-foo/STATUS.md`, statusMd("closed", "closure")],
        [`${baseSessionsDir}/session001-dev-foo/OBJETIVO.md`, "# foo"],
        [`${baseSessionsDir}/session002-dev-bar/STATUS.md`, statusMd("active", "execution")],
        [`${baseSessionsDir}/session002-dev-bar/OBJETIVO.md`, "# bar"],
      ]),
      new Map([
        [
          baseSessionsDir,
          [
            {
              name: "session001-dev-foo",
              path: `${baseSessionsDir}/session001-dev-foo`,
              type: "dir",
            },
            {
              name: "session002-dev-bar",
              path: `${baseSessionsDir}/session002-dev-bar`,
              type: "dir",
            },
          ],
        ],
        [`${baseSessionsDir}/session001-dev-foo`, []],
        [`${baseSessionsDir}/session002-dev-bar`, []],
      ]),
    );
    const result = await listSessionsForRelease(fs, "/cwd", paths);
    expect(result).toHaveLength(2);
    expect(result[0]?.code).toBe("001");
    expect(result[1]?.code).toBe("002");
  });

  it("filters by since (excludes sessions <= since code)", async () => {
    const baseSessionsDir = "/cwd/.workflow/sessions";
    const fs = new FakeFs(
      new Map([
        [`${baseSessionsDir}/session001-dev-foo/OBJETIVO.md`, "# foo"],
        [`${baseSessionsDir}/session002-dev-bar/OBJETIVO.md`, "# bar"],
        [`${baseSessionsDir}/session003-dev-baz/OBJETIVO.md`, "# baz"],
      ]),
      new Map([
        [
          baseSessionsDir,
          [
            {
              name: "session001-dev-foo",
              path: `${baseSessionsDir}/session001-dev-foo`,
              type: "dir",
            },
            {
              name: "session002-dev-bar",
              path: `${baseSessionsDir}/session002-dev-bar`,
              type: "dir",
            },
            {
              name: "session003-dev-baz",
              path: `${baseSessionsDir}/session003-dev-baz`,
              type: "dir",
            },
          ],
        ],
        [`${baseSessionsDir}/session001-dev-foo`, []],
        [`${baseSessionsDir}/session002-dev-bar`, []],
        [`${baseSessionsDir}/session003-dev-baz`, []],
      ]),
    );
    const result = await listSessionsForRelease(fs, "/cwd", paths, { since: "001" });
    expect(result).toHaveLength(2);
    expect(result[0]?.code).toBe("002");
    expect(result[1]?.code).toBe("003");
  });

  it("flags legacy format when REQUIREMENTS.md exists without OBJETIVO.md", async () => {
    const baseSessionsDir = "/cwd/.workflow/sessions";
    const sessionPath = `${baseSessionsDir}/session001-dev-legacy`;
    const fs = new FakeFs(
      new Map([
        [`${sessionPath}/REQUIREMENTS.md`, "# Legacy\nOld format"],
        // No OBJETIVO.md
      ]),
      new Map([
        [baseSessionsDir, [{ name: "session001-dev-legacy", path: sessionPath, type: "dir" }]],
        [sessionPath, []],
      ]),
    );
    const result = await listSessionsForRelease(fs, "/cwd", paths);
    expect(result).toHaveLength(1);
    expect(result[0]?.is_legacy_format).toBe(true);
    expect(result[0]?.release_eligible).toBe(false);
  });

  it("does NOT flag legacy when both REQUIREMENTS.md and OBJETIVO.md exist (transitional)", async () => {
    const baseSessionsDir = "/cwd/.workflow/sessions";
    const sessionPath = `${baseSessionsDir}/session001-dev-trans`;
    const fs = new FakeFs(
      new Map([
        [`${sessionPath}/REQUIREMENTS.md`, "# Legacy"],
        [`${sessionPath}/OBJETIVO.md`, "# Migrated"],
      ]),
      new Map([
        [baseSessionsDir, [{ name: "session001-dev-trans", path: sessionPath, type: "dir" }]],
        [sessionPath, []],
      ]),
    );
    const result = await listSessionsForRelease(fs, "/cwd", paths);
    expect(result[0]?.is_legacy_format).toBe(false);
    expect(result[0]?.release_eligible).toBe(true);
  });

  it("filters out active sessions when includeOpen is false", async () => {
    const baseSessionsDir = "/cwd/.workflow/sessions";
    const fs = new FakeFs(
      new Map([
        [`${baseSessionsDir}/session001-dev-active/OBJETIVO.md`, "# active"],
        // Closed state is derived from the folder-local `.closed` sentinel.
        [`${baseSessionsDir}/session002-dev-closed/.closed`, ""],
        [`${baseSessionsDir}/session002-dev-closed/OBJETIVO.md`, "# closed"],
      ]),
      new Map([
        [
          baseSessionsDir,
          [
            {
              name: "session001-dev-active",
              path: `${baseSessionsDir}/session001-dev-active`,
              type: "dir",
            },
            {
              name: "session002-dev-closed",
              path: `${baseSessionsDir}/session002-dev-closed`,
              type: "dir",
            },
          ],
        ],
        [`${baseSessionsDir}/session001-dev-active`, []],
        [
          `${baseSessionsDir}/session002-dev-closed`,
          [
            {
              name: ".closed",
              path: `${baseSessionsDir}/session002-dev-closed/.closed`,
              type: "file",
            },
          ],
        ],
      ]),
    );
    const result = await listSessionsForRelease(fs, "/cwd", paths, { includeOpen: false });
    expect(result).toHaveLength(1);
    expect(result[0]?.code).toBe("002");
    expect(result[0]?.state).toBe("closed");
  });

  it("lists every session folder (slug-named), skipping files", async () => {
    // New model: any directory under .workflow/sessions/ is a session (slug-named);
    // only files (and dotfile dirs) are skipped.
    const baseSessionsDir = "/cwd/.workflow/sessions";
    const fs = new FakeFs(
      new Map([[`${baseSessionsDir}/003-spec-spec-refine/SESSION.md`, "# ok"]]),
      new Map([
        [
          baseSessionsDir,
          [
            {
              name: "003-spec-spec-refine",
              path: `${baseSessionsDir}/003-spec-spec-refine`,
              type: "dir",
            },
            { name: "README.md", path: `${baseSessionsDir}/README.md`, type: "file" },
          ],
        ],
        [`${baseSessionsDir}/003-spec-spec-refine`, []],
      ]),
    );
    const result = await listSessionsForRelease(fs, "/cwd", paths);
    expect(result).toHaveLength(1);
    expect(result[0]?.code).toBe("003-spec-spec-refine");
  });

  describe("--sessions discrete filter", () => {
    const baseSessionsDir = "/cwd/.workflow/sessions";

    function fsWithSessions(codes: string[]): FakeFs {
      const files = new Map<string, string>();
      const dirEntries: DirEntry[] = [];
      for (const c of codes) {
        const folder = `session${c}-dev-foo`;
        const path = `${baseSessionsDir}/${folder}`;
        files.set(`${path}/OBJETIVO.md`, `# ${c}`);
        dirEntries.push({ name: folder, path, type: "dir" });
      }
      const dirs = new Map<string, DirEntry[]>([[baseSessionsDir, dirEntries]]);
      for (const c of codes) {
        dirs.set(`${baseSessionsDir}/session${c}-dev-foo`, []);
      }
      return new FakeFs(files, dirs);
    }

    it("filters by discrete codes (order from dir, not from input)", async () => {
      const fs = fsWithSessions(["001", "002", "003", "005"]);
      const result = await listSessionsForRelease(fs, "/cwd", paths, {
        sessions: ["003", "001"],
      });
      expect(result).toHaveLength(2);
      expect(result.map((r) => r.code)).toEqual(["001", "003"]);
    });

    it("ignores --since when sessions filter is present (precedence)", async () => {
      const fs = fsWithSessions(["001", "002", "003"]);
      const result = await listSessionsForRelease(fs, "/cwd", paths, {
        sessions: ["001"],
        since: "002",
      });
      expect(result).toHaveLength(1);
      expect(result[0]?.code).toBe("001");
    });

    it("throws UNKNOWN_SESSION when requested code does not exist", async () => {
      const fs = fsWithSessions(["001", "002"]);
      await expect(
        listSessionsForRelease(fs, "/cwd", paths, { sessions: ["999"] }),
      ).rejects.toThrow(/999/);
    });

    it("returns empty array when sessions=[] (treated as no filter)", async () => {
      const fs = fsWithSessions(["001", "002"]);
      const result = await listSessionsForRelease(fs, "/cwd", paths, { sessions: [] });
      expect(result).toHaveLength(2);
    });
  });
});

describe("readSessionArtifacts", () => {
  it("returns session_not_found when sessions dir is missing", async () => {
    const fs = new FakeFs();
    const result = await readSessionArtifacts(fs, new FakeEnv(), paths, "001");
    expect(result.error).toBe("session_not_found:001");
  });

  it("returns session_not_found when no folder matches the code", async () => {
    const baseSessionsDir = "/cwd/.workflow/sessions";
    const fs = new FakeFs(new Map(), new Map([[baseSessionsDir, []]]));
    const result = await readSessionArtifacts(fs, new FakeEnv(), paths, "001");
    expect(result.error).toBe("session_not_found:001");
  });

  it("returns legacy_format error when only REQUIREMENTS.md exists", async () => {
    const baseSessionsDir = "/cwd/.workflow/sessions";
    const sessionPath = `${baseSessionsDir}/session001-dev-old`;
    const fs = new FakeFs(
      new Map([[`${sessionPath}/REQUIREMENTS.md`, "# old"]]),
      new Map([
        [baseSessionsDir, [{ name: "session001-dev-old", path: sessionPath, type: "dir" }]],
        [sessionPath, []],
      ]),
    );
    const result = await readSessionArtifacts(fs, new FakeEnv(), paths, "001");
    expect(result.error).toBe("legacy_format");
    expect(result.session).toBe("session001-dev-old");
    expect(result.hint).toContain("REQUIREMENTS.md");
  });

  it("returns content for OBJETIVO.md when present", async () => {
    const baseSessionsDir = "/cwd/.workflow/sessions";
    const sessionPath = `${baseSessionsDir}/session042-dev-target`;
    const objetivoContent = "# Objetivo\n## Requerimiento\nTest content\n";
    const fs = new FakeFs(
      new Map([[`${sessionPath}/OBJETIVO.md`, objetivoContent]]),
      new Map([
        [baseSessionsDir, [{ name: "session042-dev-target", path: sessionPath, type: "dir" }]],
        [sessionPath, []],
      ]),
    );
    const result = await readSessionArtifacts(fs, new FakeEnv(), paths, "042", ["objetivo"]);
    expect(result.error).toBeUndefined();
    expect(result.session).toBe("session042-dev-target");
    const objetivo = (result as Record<string, unknown>).objetivo as { content: string };
    expect(objetivo.content).toBe(objetivoContent);
  });

  it("returns null for missing artifact kinds", async () => {
    const baseSessionsDir = "/cwd/.workflow/sessions";
    const sessionPath = `${baseSessionsDir}/session001-dev-min`;
    const fs = new FakeFs(
      new Map([[`${sessionPath}/OBJETIVO.md`, "# bare"]]),
      new Map([
        [baseSessionsDir, [{ name: "session001-dev-min", path: sessionPath, type: "dir" }]],
        [sessionPath, []],
      ]),
    );
    const result = await readSessionArtifacts(fs, new FakeEnv(), paths, "001", [
      "decisiones",
      "tasks",
    ]);
    expect((result as Record<string, unknown>).decisiones).toBeNull();
    expect((result as Record<string, unknown>).tasks).toBeNull();
  });

  it("returns scripts list (empty when scripts/ dir absent)", async () => {
    const baseSessionsDir = "/cwd/.workflow/sessions";
    const sessionPath = `${baseSessionsDir}/session001-dev-noscripts`;
    const fs = new FakeFs(
      new Map([[`${sessionPath}/OBJETIVO.md`, "# bare"]]),
      new Map([
        [baseSessionsDir, [{ name: "session001-dev-noscripts", path: sessionPath, type: "dir" }]],
        [sessionPath, []],
      ]),
    );
    const result = await readSessionArtifacts(fs, new FakeEnv(), paths, "001", ["scripts"]);
    expect(result.scripts).toEqual([]);
  });

  it("normalizes session code with 'session' prefix and pads to 3 digits", async () => {
    const baseSessionsDir = "/cwd/.workflow/sessions";
    const sessionPath = `${baseSessionsDir}/session007-dev-norm`;
    const fs = new FakeFs(
      new Map([[`${sessionPath}/OBJETIVO.md`, "# norm"]]),
      new Map([
        [baseSessionsDir, [{ name: "session007-dev-norm", path: sessionPath, type: "dir" }]],
        [sessionPath, []],
      ]),
    );
    const r1 = await readSessionArtifacts(fs, new FakeEnv(), paths, "7");
    expect(r1.session).toBe("session007-dev-norm");
    const r2 = await readSessionArtifacts(fs, new FakeEnv(), paths, "session007");
    expect(r2.session).toBe("session007-dev-norm");
  });
});
