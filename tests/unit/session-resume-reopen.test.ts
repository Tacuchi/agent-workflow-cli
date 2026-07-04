import { describe, expect, it } from "vitest";
import { PathsService } from "../../src/application/paths-service.js";
import { runSessionResume } from "../../src/application/session-resume-service.js";
import type { CliContext } from "../../src/cli/types.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { MemFs as FakeFs } from "../helpers/mem-fs.js";

const ns = normalizeNamespace("workflow");
const paths = new PathsService(ns, "/home/u", "/cwd");
const sessionsDir = "/cwd/.workflow/sessions";
const folder = "003-foo-quick";
const sessionPath = `${sessionsDir}/${folder}`;
const closedMarker = `${sessionPath}/.closed`;

function buildFs(opts: { closed: boolean }): FakeFs {
  const fs = new FakeFs({ lenient: true });
  fs.file(
    `${sessionPath}/SESSION.md`,
    "# SESSION — foo\n\n## Objective\nhacer foo\n\n## Type\nquick\n",
  );
  if (opts.closed) fs.file(closedMarker, "");
  return fs;
}

describe("runSessionResume --reopen", () => {
  it("reopens a closed session: removes .closed and returns state active", async () => {
    const fs = buildFs({ closed: true });
    const result = await runSessionResume(fs, new FakeEnv("/home/u", "/cwd"), paths, {
      code: "003",
      reopen: true,
    });
    if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
    expect(result.state).toBe("active");
    expect(await fs.exists(closedMarker)).toBe(false);
  });

  it("without reopen, a closed session stays closed (read-only resume)", async () => {
    const fs = buildFs({ closed: true });
    const result = await runSessionResume(fs, new FakeEnv("/home/u", "/cwd"), paths, {
      code: "003",
    });
    if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
    expect(result.state).toBe("closed");
    expect(await fs.exists(closedMarker)).toBe(true);
  });

  it("reopen on an already-active session is a no-op (stays active)", async () => {
    const fs = buildFs({ closed: false });
    const result = await runSessionResume(fs, new FakeEnv("/home/u", "/cwd"), paths, {
      code: "003",
      reopen: true,
    });
    if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
    expect(result.state).toBe("active");
  });
});

describe("session-resume / session-artifacts commands — not-found envelope", () => {
  // Regression: both commands wrapped every service result in {ok:true, exitCode:0},
  // so a nonexistent session looked like success to loops keying off exit codes.
  function fakeCtx(fs: FakeFs): CliContext {
    return { fs, env: new FakeEnv("/home/u", "/cwd"), paths } as unknown as CliContext;
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
