import { describe, expect, it } from "vitest";
import { PathsService } from "../../src/application/paths-service.js";
import { runSessionResume } from "../../src/application/session-resume-service.js";
import type { CliContext } from "../../src/cli/types.js";
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
    for (const [dir, entries] of this.dirs) {
      this.dirs.set(
        dir,
        entries.filter((e) => e.path !== p),
      );
    }
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

const ns = normalizeNamespace("workflow");
const paths = new PathsService(ns, "/home/u", "/cwd");
const sessionsDir = "/cwd/.workflow/sessions";
const folder = "003-foo-quick";
const sessionPath = `${sessionsDir}/${folder}`;
const closedMarker = `${sessionPath}/.closed`;

function buildFs(opts: { closed: boolean }): FakeFs {
  const files = new Map<string, string>();
  files.set(
    `${sessionPath}/SESSION.md`,
    "# SESSION — foo\n\n## Objective\nhacer foo\n\n## Type\nquick\n",
  );
  const dirEntries: DirEntry[] = [
    { name: "SESSION.md", path: `${sessionPath}/SESSION.md`, type: "file" },
  ];
  if (opts.closed) {
    files.set(closedMarker, "");
    dirEntries.push({ name: ".closed", path: closedMarker, type: "file" });
  }
  const dirs = new Map<string, DirEntry[]>();
  dirs.set(sessionsDir, [{ name: folder, path: sessionPath, type: "dir" }]);
  dirs.set(sessionPath, dirEntries);
  return new FakeFs(files, dirs);
}

describe("runSessionResume --reopen", () => {
  it("reopens a closed session: removes .closed and returns state active", async () => {
    const fs = buildFs({ closed: true });
    const result = await runSessionResume(fs, new FakeEnv(), paths, { code: "003", reopen: true });
    if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
    expect(result.state).toBe("active");
    expect(await fs.exists(closedMarker)).toBe(false);
  });

  it("without reopen, a closed session stays closed (read-only resume)", async () => {
    const fs = buildFs({ closed: true });
    const result = await runSessionResume(fs, new FakeEnv(), paths, { code: "003" });
    if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
    expect(result.state).toBe("closed");
    expect(await fs.exists(closedMarker)).toBe(true);
  });

  it("reopen on an already-active session is a no-op (stays active)", async () => {
    const fs = buildFs({ closed: false });
    const result = await runSessionResume(fs, new FakeEnv(), paths, { code: "003", reopen: true });
    if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
    expect(result.state).toBe("active");
  });
});

describe("session-resume / session-artifacts commands — not-found envelope", () => {
  // Regression: both commands wrapped every service result in {ok:true, exitCode:0},
  // so a nonexistent session looked like success to loops keying off exit codes.
  function fakeCtx(fs: FakeFs): CliContext {
    return { fs, env: new FakeEnv(), paths } as unknown as CliContext;
  }

  it("session-resume maps session_not_found to ok:false + exit 1", async () => {
    const { sessionResumeCommand } = await import("../../src/cli/commands/session-resume.js");
    const args = {
      rest: [],
      plugin: {},
      flags: new Set<string>(),
      values: new Map([["code", "999"]]),
      valuesMulti: new Map(),
    };
    const result = await sessionResumeCommand.execute(args, fakeCtx(buildFs({ closed: false })));
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.error?.code).toBe("SESSION_NOT_FOUND");
  });

  it("session-artifacts maps session_not_found to ok:false + exit 1", async () => {
    const { sessionArtifactsCommand } = await import("../../src/cli/commands/session-artifacts.js");
    const args = {
      rest: [],
      plugin: {},
      flags: new Set<string>(),
      values: new Map([["code", "999"]]),
      valuesMulti: new Map(),
    };
    const result = await sessionArtifactsCommand.execute(args, fakeCtx(buildFs({ closed: false })));
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.error?.code).toBe("SESSION_NOT_FOUND");
  });
});
