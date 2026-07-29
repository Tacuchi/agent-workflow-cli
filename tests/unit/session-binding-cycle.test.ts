import { describe, expect, it } from "vitest";
import { runHistoryUpdate } from "../../src/application/history-update-service.js";
import { PathsService } from "../../src/application/paths-service.js";
import {
  hashContextId,
  readBindingRegistry,
} from "../../src/application/session-binding-service.js";
import { runSessionClose } from "../../src/application/session-close-service.js";
import { runSessionCreate } from "../../src/application/session-create-service.js";
import { resolveSessionTarget } from "../../src/application/session-resolver.js";
import { runSessionResume } from "../../src/application/session-resume-service.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { MemFs as FakeFs } from "../helpers/mem-fs.js";

const ns = normalizeNamespace("workflow");
const sessionsDir = "/cwd/.workflow/sessions";
const bindingsFile = `${sessionsDir}/.bindings.json`;
const env = new FakeEnv("/home/u", "/cwd");

/** A fresh PathsService models a NEW process reading the same filesystem. */
function newProcessPaths(): PathsService {
  return new PathsService(ns, "/home/u", "/cwd");
}

const paths = newProcessPaths();

function seed(folders: { folder: string; closed?: boolean }[]): FakeFs {
  const fs = new FakeFs({ lenient: true });
  for (const f of folders) {
    fs.file(`${sessionsDir}/${f.folder}/SESSION.md`, `# SESSION — ${f.folder}\n`);
    if (f.closed === true) fs.file(`${sessionsDir}/${f.folder}/.closed`, "");
  }
  return fs;
}

/** Simulate another live operation holding the workspace lock. */
async function holdWorkspaceLock(fs: FakeFs): Promise<void> {
  await fs.writeText(
    paths.cwdLockFile(),
    JSON.stringify({ pid: 999999, ts: new Date().toISOString() }),
  );
}

async function boundFolder(fs: FakeFs, contextId: string): Promise<string | undefined> {
  const read = await readBindingRegistry(fs, paths);
  if (!read.ok) throw new Error(`registry invalid: ${read.reason}`);
  return read.registry.bindings[hashContextId(contextId)];
}

describe("binding registry — privacy and shape", () => {
  it("persists only the SHA-256 of the conversation id, never the raw value", async () => {
    const fs = seed([{ folder: "001-sola-quick" }]);
    await resolveSessionTarget(fs, paths, { contextId: "super-secret-conversation", bind: true });
    const raw = await fs.readText(bindingsFile);
    expect(raw).not.toContain("super-secret-conversation");
    expect(raw).toContain(hashContextId("super-secret-conversation"));
    expect(JSON.parse(raw).version).toBe(1);
  });
});

describe("manual cycle — the conversation keeps its own line", () => {
  it("session-create associates the conversation with the session it just created", async () => {
    const fs = new FakeFs({ lenient: true });
    const result = await runSessionCreate(fs, paths, {
      type: "exec",
      name: "continuidad-plan-exec",
      objetivo: "x",
      contextId: "conv-a",
    });
    if ("error" in result) throw new Error(result.error);
    expect(result.sessionCreate.folder).toBe("001-continuidad-plan-exec");
    expect(await boundFolder(fs, "conv-a")).toBe("001-continuidad-plan-exec");
  });

  it("the sole-active fallback associates the conversation for later operations", async () => {
    const fs = seed([{ folder: "001-sola-quick" }]);
    const first = await resolveSessionTarget(fs, paths, { contextId: "conv-a", bind: true });
    expect(first.outcome === "resolved" && first.via).toBe("sole_active");

    // A second session appears; a NEW process must still land on the associated
    // one instead of becoming ambiguous.
    fs.file(`${sessionsDir}/002-otra-quick/SESSION.md`, "# SESSION — 002-otra-quick\n");
    const later = await resolveSessionTarget(fs, newProcessPaths(), { contextId: "conv-a" });
    expect(later.outcome === "resolved" && later.session.folder).toBe("001-sola-quick");
    expect(later.outcome === "resolved" && later.via).toBe("binding");
  });

  it("re-associating one conversation leaves every other association untouched", async () => {
    const fs = seed([{ folder: "001-a-quick" }, { folder: "002-b-quick" }]);
    await resolveSessionTarget(fs, paths, { code: "001", contextId: "conv-a", bind: true });
    await resolveSessionTarget(fs, paths, { code: "002", contextId: "conv-b", bind: true });

    // conv-a moves to 002; conv-b must not move with it.
    await resolveSessionTarget(fs, paths, { code: "002", contextId: "conv-a", bind: true });
    expect(await boundFolder(fs, "conv-a")).toBe("002-b-quick");
    expect(await boundFolder(fs, "conv-b")).toBe("002-b-quick");

    await resolveSessionTarget(fs, paths, { code: "001", contextId: "conv-b", bind: true });
    expect(await boundFolder(fs, "conv-a")).toBe("002-b-quick");
    expect(await boundFolder(fs, "conv-b")).toBe("001-a-quick");
  });

  // Regression guard: associating used to take the workspace lock on EVERY
  // resolution, so an ordinary read contended with — and failed under — any
  // concurrent close. An association that already points at the target is a
  // no-op and must stay lock-free.
  it("a read whose association already points here survives a held lock", async () => {
    const fs = seed([{ folder: "001-a-quick" }, { folder: "002-b-quick" }]);
    await resolveSessionTarget(fs, paths, { code: "001", contextId: "conv-a", bind: true });
    await holdWorkspaceLock(fs);

    const again = await resolveSessionTarget(fs, paths, {
      code: "001",
      contextId: "conv-a",
      bind: true,
    });
    expect(again.outcome === "resolved" && again.session.folder).toBe("001-a-quick");
  });

  it("a read that WOULD re-associate under a held lock fails visibly, never silently", async () => {
    const fs = seed([{ folder: "001-a-quick" }, { folder: "002-b-quick" }]);
    await resolveSessionTarget(fs, paths, { code: "001", contextId: "conv-a", bind: true });
    await holdWorkspaceLock(fs);

    const moved = await resolveSessionTarget(fs, paths, {
      code: "002",
      contextId: "conv-a",
      bind: true,
    });
    expect(moved.outcome === "error" && moved.code).toBe("SESSION_BINDING_INVALID");
    expect(await boundFolder(fs, "conv-a")).toBe("001-a-quick");
  });

  it("reading a closed session never associates the conversation with it", async () => {
    const fs = seed([{ folder: "001-cerrada-quick", closed: true }]);
    await resolveSessionTarget(fs, paths, {
      code: "001",
      contextId: "conv-a",
      allowClosed: true,
      bind: true,
    });
    expect(await boundFolder(fs, "conv-a")).toBeUndefined();
  });
});

describe("session-resume — reopen is always an explicit selection", () => {
  it("--reopen without a target is refused instead of guessing", async () => {
    const fs = seed([{ folder: "001-sola-quick", closed: true }]);
    const result = await runSessionResume(fs, env, paths, { reopen: true, contextId: "conv-a" });
    if (!("error" in result)) throw new Error("expected an error");
    expect(result.code).toBe("INVALID_INPUT");
    expect(await fs.exists(`${sessionsDir}/001-sola-quick/.closed`)).toBe(true);
  });

  it("--reopen with a target reactivates it and associates the conversation", async () => {
    const fs = seed([{ folder: "001-sola-quick", closed: true }]);
    const result = await runSessionResume(fs, env, paths, {
      code: "001",
      reopen: true,
      contextId: "conv-a",
    });
    if ("error" in result || "sessionError" in result) throw new Error("expected success");
    expect(result.state).toBe("active");
    expect(await fs.exists(`${sessionsDir}/001-sola-quick/.closed`)).toBe(false);
    expect(await boundFolder(fs, "conv-a")).toBe("001-sola-quick");
  });
});

describe("session-close — releases only the associations pointing at it", () => {
  it("invalidates its own bindings and leaves the other conversation intact", async () => {
    const fs = seed([{ folder: "001-a-quick" }, { folder: "002-b-quick" }]);
    await resolveSessionTarget(fs, paths, { code: "001", contextId: "conv-a", bind: true });
    await resolveSessionTarget(fs, paths, { code: "002", contextId: "conv-b", bind: true });

    const closed = await runSessionClose(fs, paths, { code: "001" });
    if (!("sessionClose" in closed)) throw new Error("expected a successful close");
    expect(closed.sessionClose.bindings_invalidated).toBe(1);
    expect(await boundFolder(fs, "conv-a")).toBeUndefined();
    expect(await boundFolder(fs, "conv-b")).toBe("002-b-quick");

    // conv-b's line and its resolution are untouched by the other's close.
    const still = await resolveSessionTarget(fs, newProcessPaths(), { contextId: "conv-b" });
    expect(still.outcome === "resolved" && still.session.folder).toBe("002-b-quick");
  });
});

describe("infrastructure reads never associate", () => {
  it("history-update writes its row without touching the bindings registry", async () => {
    const fs = seed([{ folder: "001-sola-quick" }]);
    const result = await runHistoryUpdate(fs, paths, { code: "001-sola-quick", state: "closed" });
    expect("error" in result).toBe(false);
    expect(await fs.exists(bindingsFile)).toBe(false);
  });
});
