import { describe, expect, it } from "vitest";
import { PathsService } from "../../src/application/paths-service.js";
import { resolveSession } from "../../src/application/session-resolver.js";
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
    private files: Map<string, string>,
    private dirs: Map<string, DirEntry[]>,
  ) {}
  async readText(p: string) {
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
  async exists(p: string) {
    return this.files.has(p) || this.dirs.has(p);
  }
  async list(p: string): Promise<DirEntry[]> {
    return this.dirs.get(p) ?? [];
  }
  async mkdirp(): Promise<void> {}
  async stat(p: string): Promise<FileStat> {
    if (this.files.has(p)) return { mtime: new Date(0), size: 0, type: "file" };
    if (this.dirs.has(p)) return { mtime: new Date(0), size: 0, type: "dir" };
    throw new Error(`ENOENT: ${p}`);
  }
}

const paths = new PathsService(normalizeNamespace("workflow"), "/home/u", "/cwd");
const sessionsDir = "/cwd/.workflow/sessions";

/** Build a FakeFs whose sessions dir holds the given (all-active) folders. */
function buildFs(folders: string[]): FakeFs {
  const files = new Map<string, string>();
  const dirs = new Map<string, DirEntry[]>();
  const topEntries: DirEntry[] = [];
  for (const folder of folders) {
    const path = `${sessionsDir}/${folder}`;
    const sessionMd = `${path}/SESSION.md`;
    files.set(sessionMd, `# SESSION — ${folder}\n\n## Type\nquick\n`);
    dirs.set(path, [{ name: "SESSION.md", path: sessionMd, type: "file" }]);
    topEntries.push({ name: folder, path, type: "dir" });
  }
  dirs.set(sessionsDir, topEntries);
  return new FakeFs(files, dirs);
}

describe("resolveSession — numeric code word-boundary", () => {
  // Reachable once a workspace passes 999 sessions: the global counter emits
  // 4-digit prefixes that coexist with old 3-digit folders. A bare `startsWith`
  // makes code "100" fuzzy-match "1000-…" (folders are scanned high→low), so the
  // wrong session resolves silently.
  it("resolves a 3-digit code to its own folder, not a longer-numbered one", async () => {
    const fs = buildFs(["100-target-quick", "1000-decoy-quick"]);
    const entry = await resolveSession(fs, new FakeEnv(), paths, "100");
    expect(entry?.folder).toBe("100-target-quick");
  });

  it("still resolves an exact full folder name", async () => {
    const fs = buildFs(["100-target-quick", "1000-decoy-quick"]);
    const entry = await resolveSession(fs, new FakeEnv(), paths, "1000-decoy-quick");
    expect(entry?.folder).toBe("1000-decoy-quick");
  });

  it("still resolves a descriptor prefix up to a dash boundary", async () => {
    const fs = buildFs(["002-correo-otp-spec-refine", "003-correo-plan-new"]);
    const entry = await resolveSession(fs, new FakeEnv(), paths, "002-correo-otp");
    expect(entry?.folder).toBe("002-correo-otp-spec-refine");
  });

  it("does not fuzzy-match a numeric code across a dash boundary (abbreviated code)", async () => {
    // "01" must not silently resolve to "012-…"; an incomplete numeric code is
    // ambiguous and should miss rather than pick the highest-numbered folder.
    const fs = buildFs(["010-a-quick", "011-b-quick", "012-c-quick"]);
    const entry = await resolveSession(fs, new FakeEnv(), paths, "01");
    expect(entry).toBeNull();
  });
});
