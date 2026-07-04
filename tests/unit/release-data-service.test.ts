import { describe, expect, it } from "vitest";
import { PathsService } from "../../src/application/paths-service.js";
import {
  listGraduatedBundles,
  listSessionsForRelease,
  listStandaloneSql,
  readSessionArtifacts,
  runReleaseData,
} from "../../src/application/release-data-service.js";
import type { DirEntry } from "../../src/ports/file-system.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { MemFs as FakeFs } from "../helpers/mem-fs.js";

const ns = normalizeNamespace("workflow");
const paths = new PathsService(ns, "/home/u", "/cwd");
const baseSessionsDir = "/cwd/.workflow/sessions";

/**
 * Builds a sessions-dir FakeFs keyed by FULL folder name. Each folder maps to its
 * files (name → content); `extraTopLevel` adds sibling entries (e.g. a top-level
 * README.md) that must show up in the sessions-dir listing but are not folders.
 */
function sessionsFs(
  sessions: Record<string, Record<string, string>>,
  extraTopLevel: DirEntry[] = [],
): FakeFs {
  const fs = new FakeFs({ lenient: true }).dir(baseSessionsDir);
  for (const [folder, files] of Object.entries(sessions)) {
    const path = `${baseSessionsDir}/${folder}`;
    fs.dir(path);
    for (const [name, content] of Object.entries(files)) {
      fs.file(`${path}/${name}`, content);
    }
  }
  for (const e of extraTopLevel) {
    if (e.type === "dir") fs.dir(e.path);
    else fs.file(e.path, "");
  }
  return fs;
}

describe("listSessionsForRelease", () => {
  it("returns empty array when sessions dir does not exist", async () => {
    const fs = new FakeFs({ lenient: true });
    const result = await listSessionsForRelease(fs, "/cwd", paths);
    expect(result).toEqual([]);
  });

  it("returns empty array when sessions dir exists but is empty", async () => {
    const fs = new FakeFs({ lenient: true }).dir(baseSessionsDir);
    const result = await listSessionsForRelease(fs, "/cwd", paths);
    expect(result).toEqual([]);
  });

  it("returns sessions sorted by code", async () => {
    const fs = sessionsFs({
      "session001-dev-foo": { "OBJETIVO.md": "# foo" },
      "session002-dev-bar": { "OBJETIVO.md": "# bar" },
    });
    const result = await listSessionsForRelease(fs, "/cwd", paths);
    expect(result).toHaveLength(2);
    expect(result[0]?.code).toBe("001");
    expect(result[1]?.code).toBe("002");
  });

  it("filters by since (excludes sessions <= since code)", async () => {
    const fs = sessionsFs({
      "session001-dev-foo": { "OBJETIVO.md": "# foo" },
      "session002-dev-bar": { "OBJETIVO.md": "# bar" },
      "session003-dev-baz": { "OBJETIVO.md": "# baz" },
    });
    const result = await listSessionsForRelease(fs, "/cwd", paths, { since: "001" });
    expect(result).toHaveLength(2);
    expect(result[0]?.code).toBe("002");
    expect(result[1]?.code).toBe("003");
  });

  it("flags legacy format when REQUIREMENTS.md exists without OBJETIVO.md", async () => {
    const fs = sessionsFs({
      "session001-dev-legacy": { "REQUIREMENTS.md": "# Legacy\nOld format" },
    });
    const result = await listSessionsForRelease(fs, "/cwd", paths);
    expect(result).toHaveLength(1);
    expect(result[0]?.is_legacy_format).toBe(true);
    expect(result[0]?.release_eligible).toBe(false);
  });

  it("does NOT flag legacy when both REQUIREMENTS.md and OBJETIVO.md exist (transitional)", async () => {
    const fs = sessionsFs({
      "session001-dev-trans": { "REQUIREMENTS.md": "# Legacy", "OBJETIVO.md": "# Migrated" },
    });
    const result = await listSessionsForRelease(fs, "/cwd", paths);
    expect(result[0]?.is_legacy_format).toBe(false);
    expect(result[0]?.release_eligible).toBe(true);
  });

  it("filters out active sessions when includeOpen is false", async () => {
    // Closed state is derived from the folder-local `.closed` sentinel.
    const fs = sessionsFs({
      "session001-dev-active": { "OBJETIVO.md": "# active" },
      "session002-dev-closed": { ".closed": "", "OBJETIVO.md": "# closed" },
    });
    const result = await listSessionsForRelease(fs, "/cwd", paths, { includeOpen: false });
    expect(result).toHaveLength(1);
    expect(result[0]?.code).toBe("002");
    expect(result[0]?.state).toBe("closed");
  });

  it("lists every session folder (slug-named), skipping files", async () => {
    // New model: any directory under .workflow/sessions/ is a session (slug-named);
    // only files (and dotfile dirs) are skipped.
    const fs = sessionsFs({ "003-spec-spec-refine": { "SESSION.md": "# ok" } }, [
      { name: "README.md", path: `${baseSessionsDir}/README.md`, type: "file" },
    ]);
    const result = await listSessionsForRelease(fs, "/cwd", paths);
    expect(result).toHaveLength(1);
    expect(result[0]?.code).toBe("003-spec-spec-refine");
  });

  describe("--sessions discrete filter", () => {
    function fsWithSessions(codes: string[]): FakeFs {
      return sessionsFs(
        Object.fromEntries(codes.map((c) => [`session${c}-dev-foo`, { "OBJETIVO.md": `# ${c}` }])),
      );
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
    const fs = new FakeFs({ lenient: true });
    const result = await readSessionArtifacts(fs, new FakeEnv("/home/u", "/cwd"), paths, "001");
    expect(result.error).toBe("session_not_found:001");
  });

  it("returns session_not_found when no folder matches the code", async () => {
    const fs = new FakeFs({ lenient: true }).dir(baseSessionsDir);
    const result = await readSessionArtifacts(fs, new FakeEnv("/home/u", "/cwd"), paths, "001");
    expect(result.error).toBe("session_not_found:001");
  });

  it("returns legacy_format error when only REQUIREMENTS.md exists", async () => {
    const fs = sessionsFs({ "session001-dev-old": { "REQUIREMENTS.md": "# old" } });
    const result = await readSessionArtifacts(fs, new FakeEnv("/home/u", "/cwd"), paths, "001");
    expect(result.error).toBe("legacy_format");
    expect(result.session).toBe("session001-dev-old");
    expect(result.hint).toContain("REQUIREMENTS.md");
  });

  it("returns content for OBJETIVO.md when present", async () => {
    const objetivoContent = "# Objetivo\n## Requerimiento\nTest content\n";
    const fs = sessionsFs({ "session042-dev-target": { "OBJETIVO.md": objetivoContent } });
    const result = await readSessionArtifacts(fs, new FakeEnv("/home/u", "/cwd"), paths, "042", [
      "objetivo",
    ]);
    expect(result.error).toBeUndefined();
    expect(result.session).toBe("session042-dev-target");
    const objetivo = (result as Record<string, unknown>).objetivo as { content: string };
    expect(objetivo.content).toBe(objetivoContent);
  });

  it("returns null for missing artifact kinds", async () => {
    const fs = sessionsFs({ "session001-dev-min": { "OBJETIVO.md": "# bare" } });
    const result = await readSessionArtifacts(fs, new FakeEnv("/home/u", "/cwd"), paths, "001", [
      "decisiones",
      "tasks",
    ]);
    expect((result as Record<string, unknown>).decisiones).toBeNull();
    expect((result as Record<string, unknown>).tasks).toBeNull();
  });

  it("returns scripts list (empty when scripts/ dir absent)", async () => {
    const fs = sessionsFs({ "session001-dev-noscripts": { "OBJETIVO.md": "# bare" } });
    const result = await readSessionArtifacts(fs, new FakeEnv("/home/u", "/cwd"), paths, "001", [
      "scripts",
    ]);
    expect(result.scripts).toEqual([]);
  });

  it("normalizes session code with 'session' prefix and pads to 3 digits", async () => {
    const fs = sessionsFs({ "session007-dev-norm": { "OBJETIVO.md": "# norm" } });
    const r1 = await readSessionArtifacts(fs, new FakeEnv("/home/u", "/cwd"), paths, "7");
    expect(r1.session).toBe("session007-dev-norm");
    const r2 = await readSessionArtifacts(fs, new FakeEnv("/home/u", "/cwd"), paths, "session007");
    expect(r2.session).toBe("session007-dev-norm");
  });
});

describe("listGraduatedBundles + listStandaloneSql (F7)", () => {
  const scripts = "/cwd/docs/scripts";

  function scriptsFs(): FakeFs {
    const modern = `${scripts}/002-export-scripts-2026-07-03`;
    const legacy = `${scripts}/001-session003-fix-indices`;
    return new FakeFs({ lenient: true })
      .file(`${modern}/01-alter.sql`, "ALTER TABLE t ADD c int;")
      .file(`${modern}/00-ROLLBACK.sql`, "ALTER TABLE t DROP COLUMN c;")
      .file(`${legacy}/01-fix.sql`, "CREATE INDEX ix ON t(c);")
      .file(`${legacy}/01-fix.rollback.sql`, "DROP INDEX ix;")
      .file(`${scripts}/suelto-limpieza.sql`, "DELETE FROM tmp;")
      .file(`${scripts}/suelto-limpieza-rollback.sql`, "-- restore tmp")
      .file(`${scripts}/notas.md`, "# no sql")
      .dir(`${scripts}/cualquier-otra-carpeta`);
  }

  it("reconoce el naming moderno NNN-export-scripts-YYYY-MM-DD y el legacy NNN-sessionNNN-slug", async () => {
    const bundles = await listGraduatedBundles(scriptsFs(), "/cwd", paths);
    expect(bundles).toHaveLength(2);
    const legacy = bundles.find((b) => b.kind === "legacy");
    const modern = bundles.find((b) => b.kind === "export");
    expect(legacy).toMatchObject({
      nnn: "001",
      session_code: "003",
      slug: "fix-indices",
      forward_count: 1,
      rollback_count: 1,
    });
    expect(modern).toMatchObject({
      nnn: "002",
      session_code: null,
      slug: "export-scripts-2026-07-03",
      forward_count: 1,
      rollback_count: 1, // 00-ROLLBACK.sql counts as rollback (modern naming)
    });
  });

  it("el filtro por sessionCode aplica solo a bundles legacy (los modernos son cross-session)", async () => {
    const bundles = await listGraduatedBundles(scriptsFs(), "/cwd", paths, { sessionCode: "003" });
    expect(bundles).toHaveLength(1);
    expect(bundles[0]?.kind).toBe("legacy");
  });

  it("listStandaloneSql: solo .sql top-level, con is_rollback y size; ignora dirs y no-sql", async () => {
    const items = await listStandaloneSql(scriptsFs(), "/cwd", paths);
    expect(items.map((i) => i.name)).toEqual([
      "suelto-limpieza-rollback.sql",
      "suelto-limpieza.sql",
    ]);
    expect(items.find((i) => i.name === "suelto-limpieza.sql")).toMatchObject({
      is_rollback: false,
    });
    expect(items.find((i) => i.name === "suelto-limpieza-rollback.sql")).toMatchObject({
      is_rollback: true,
    });
    expect(items.every((i) => typeof i.size === "number")).toBe(true);
  });

  it("is_rollback es case-insensitive (convención de casa 00-ROLLBACK.sql)", async () => {
    const fs = new FakeFs({ lenient: true }).file(`${scripts}/005-ROLLBACK.sql`, "-- restore");
    const items = await listStandaloneSql(fs, "/cwd", paths);
    expect(items[0]).toMatchObject({ name: "005-ROLLBACK.sql", is_rollback: true });
  });

  it("runReleaseData: alias desconocido devuelve {error} (el comando lo mapea a INVALID_INPUT exit 1)", async () => {
    const fs = new FakeFs({ lenient: true });
    const result = await runReleaseData(fs, new FakeEnv("/home/u", "/cwd"), paths, {
      sourceAlias: "fantasma",
    });
    expect("error" in result).toBe(true);
  });

  it("runReleaseData: --standalone-sql agrega standalone_sql al payload", async () => {
    const result = await runReleaseData(scriptsFs(), new FakeEnv("/home/u", "/cwd"), paths, {
      includeStandaloneSql: true,
    });
    if ("error" in result) throw new Error(result.error);
    expect(result.standalone_sql).toHaveLength(2);
  });
});
