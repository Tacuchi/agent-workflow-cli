import { describe, expect, it } from "vitest";
import { PathsService } from "../../src/application/paths-service.js";
import {
  hashContextId,
  readBindingRegistry,
} from "../../src/application/session-binding-service.js";
import { runSessionClose } from "../../src/application/session-close-service.js";
import { runSessionCreate } from "../../src/application/session-create-service.js";
import { resolveSessionTarget } from "../../src/application/session-resolver.js";
import type { DirEntry } from "../../src/ports/file-system.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { MemFs } from "../helpers/mem-fs.js";

const paths = new PathsService(normalizeNamespace("workflow"), "/home/u", "/cwd");
const sessionsDir = "/cwd/.workflow/sessions";

/**
 * Yields the microtask queue inside `list`, so two concurrent operations really
 * interleave between "scan the sessions dir" and "create the folder" — the exact
 * window where two creations could claim the same `NNN`. Without it both calls
 * would run to completion one after the other and prove nothing.
 */
class InterleavingFs extends MemFs {
  override async list(path: string): Promise<DirEntry[]> {
    await Promise.resolve();
    await Promise.resolve();
    return super.list(path);
  }
}

function seed(folders: string[], fs: MemFs = new MemFs({ lenient: true })): MemFs {
  for (const folder of folders) {
    fs.file(`${sessionsDir}/${folder}/SESSION.md`, `# SESSION — ${folder}\n`);
  }
  return fs;
}

async function bindingsOf(fs: MemFs): Promise<Record<string, string>> {
  const read = await readBindingRegistry(fs, paths);
  if (!read.ok) throw new Error(`registry invalid: ${read.reason}`);
  return read.registry.bindings;
}

describe("create/create race — a number is never claimed twice", () => {
  it("two concurrent creations never produce the same folder", async () => {
    const fs = new InterleavingFs({ lenient: true });
    const [a, b] = await Promise.all([
      runSessionCreate(fs, paths, { type: "exec", name: "alfa-plan-exec", objetivo: "a" }),
      runSessionCreate(fs, paths, { type: "quick", name: "beta-quick", objetivo: "b" }),
    ]);

    const ok = [a, b].filter((r): r is Exclude<typeof r, { error: string }> => !("error" in r));
    const failed = [a, b].filter((r) => "error" in r);

    // The invariant is the NUMBER, not the folder name. Unprotected, both calls
    // read the same counter and happily create `001-alfa-plan-exec` AND
    // `001-beta-quick`: two distinct folders sharing one session number, which
    // is what the global sequential counter exists to prevent.
    const numbers = ok.map((r) => r.sessionCreate.number);
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(ok.length + failed.length).toBe(2);
    for (const f of failed) {
      if (!("error" in f)) continue;
      expect(f.code).toBe("LOCK_BUSY");
    }

    const onDisk = (await fs.list(sessionsDir))
      .filter((e) => e.type === "dir")
      .map((e) => e.name)
      .sort();
    expect(onDisk).toEqual(ok.map((r) => r.sessionCreate.folder).sort());
    // Every folder on disk carries a distinct `NNN-` prefix.
    expect(new Set(onDisk.map((n) => n.slice(0, 3))).size).toBe(onDisk.length);
  });
});

describe("rebind/close race — one conversation never steals another's line", () => {
  it("a concurrent close and rebind leave a valid registry and no closed target bound", async () => {
    const fs = new InterleavingFs({ lenient: true });
    seed(["001-a-quick", "002-b-quick"], fs);
    await resolveSessionTarget(fs, paths, {
      code: "001",
      contextId: "conv-a",
      bind: true,
      intent: "write",
    });

    // conv-b claims 002 at the same moment conv-a's session is being closed.
    const [closed, bound] = await Promise.all([
      runSessionClose(fs, paths, { code: "001" }),
      resolveSessionTarget(fs, paths, {
        code: "002",
        contextId: "conv-b",
        bind: true,
        intent: "write",
      }),
    ]);

    // Whatever the interleaving, the registry stays parseable...
    const bindings = await bindingsOf(fs);
    // ...conv-a is never left pointing at a session that got closed...
    const closedOk = "sessionClose" in closed;
    if (closedOk) expect(bindings[hashContextId("conv-a")]).toBeUndefined();
    // ...and conv-b either got its line or an actionable error, never conv-a's.
    if (bound.outcome === "resolved") {
      expect(bound.session.folder).toBe("002-b-quick");
    } else {
      expect(bound.code).toBe("SESSION_BINDING_INVALID");
    }
    expect(bindings[hashContextId("conv-b")]).not.toBe("001-a-quick");
  });

  it("closing under contention never half-closes: marker and bindings agree", async () => {
    const fs = new InterleavingFs({ lenient: true });
    seed(["001-a-quick"], fs);
    await resolveSessionTarget(fs, paths, {
      code: "001",
      contextId: "conv-a",
      bind: true,
      intent: "write",
    });

    const [first, second] = await Promise.all([
      runSessionClose(fs, paths, { code: "001" }),
      runSessionClose(fs, paths, { code: "001" }),
    ]);

    const marked = await fs.exists(`${sessionsDir}/001-a-quick/.closed`);
    const bindings = await bindingsOf(fs);
    const anySucceeded = "sessionClose" in first || "sessionClose" in second;
    // The pair is all-or-nothing: a session marked closed always has its
    // associations released, and a refused close leaves both untouched.
    expect(marked).toBe(anySucceeded);
    if (marked) expect(bindings[hashContextId("conv-a")]).toBeUndefined();
    else expect(bindings[hashContextId("conv-a")]).toBe("001-a-quick");
  });
});

describe("the full identity matrix resolves one target or one actionable error", () => {
  // current/legacy × zero/one/several × active/closed × explicit/binding/sole.
  // Every row asserts BOTH halves of the contract: what comes back, and that
  // the workspace was not mutated on the way.
  const rows: {
    name: string;
    folders: { folder: string; closed?: boolean }[];
    request: { code?: string; contextId?: string };
    bound?: string;
    expect: { folder: string } | { code: string };
  }[] = [
    {
      name: "zero sessions, no identity",
      folders: [],
      request: {},
      expect: { code: "SESSION_NOT_FOUND" },
    },
    {
      name: "one active, no identity → sole active",
      folders: [{ folder: "001-a-quick" }],
      request: {},
      expect: { folder: "001-a-quick" },
    },
    {
      name: "one closed only, no identity",
      folders: [{ folder: "001-a-quick", closed: true }],
      request: {},
      expect: { code: "SESSION_NOT_FOUND" },
    },
    {
      name: "several active, no identity",
      folders: [{ folder: "001-a-quick" }, { folder: "002-b-quick" }],
      request: {},
      expect: { code: "SESSION_AMBIGUOUS" },
    },
    {
      name: "several active, current-model explicit code",
      folders: [{ folder: "001-a-quick" }, { folder: "002-b-quick" }],
      request: { code: "002" },
      expect: { folder: "002-b-quick" },
    },
    {
      name: "several active, legacy explicit code",
      folders: [{ folder: "001-a-quick" }, { folder: "session007-legacy" }],
      request: { code: "007" },
      expect: { folder: "session007-legacy" },
    },
    {
      // A workspace whose legacy series was never brought over: `047` names two
      // sessions, and the bare number cannot choose between them.
      name: "legacy y modelo nuevo comparten número, código desnudo",
      folders: [{ folder: "047-algo-quick" }, { folder: "session047-legacy-x" }],
      request: { code: "047" },
      expect: { code: "SESSION_AMBIGUOUS" },
    },
    {
      // …and the way out the error advertises resolves to exactly one: the exact
      // folder ends the search before the numeric reading matches both again.
      name: "legacy en colisión, nombrada por su carpeta exacta",
      folders: [{ folder: "047-algo-quick" }, { folder: "session047-legacy-x" }],
      request: { code: "session047-legacy-x" },
      expect: { folder: "session047-legacy-x" },
    },
    {
      name: "la del modelo nuevo en colisión, también por su carpeta exacta",
      folders: [{ folder: "047-algo-quick" }, { folder: "session047-legacy-x" }],
      request: { code: "047-algo-quick" },
      expect: { folder: "047-algo-quick" },
    },
    {
      name: "several active, binding decides",
      folders: [{ folder: "001-a-quick" }, { folder: "002-b-quick" }],
      request: { contextId: "conv-a" },
      bound: "001-a-quick",
      expect: { folder: "001-a-quick" },
    },
    {
      name: "explicit beats the binding",
      folders: [{ folder: "001-a-quick" }, { folder: "002-b-quick" }],
      request: { code: "002", contextId: "conv-a" },
      bound: "001-a-quick",
      expect: { folder: "002-b-quick" },
    },
    {
      name: "invalid explicit ends it, binding is not consulted",
      folders: [{ folder: "001-a-quick" }, { folder: "002-b-quick" }],
      request: { code: "999", contextId: "conv-a" },
      bound: "001-a-quick",
      expect: { code: "SESSION_NOT_FOUND" },
    },
    {
      name: "explicit closed target",
      folders: [{ folder: "001-a-quick", closed: true }, { folder: "002-b-quick" }],
      request: { code: "001" },
      expect: { code: "SESSION_CLOSED" },
    },
    {
      name: "binding gone stale never falls back to the sole active",
      folders: [{ folder: "002-b-quick" }],
      request: { contextId: "conv-a" },
      bound: "001-desaparecida-quick",
      expect: { code: "SESSION_BINDING_INVALID" },
    },
  ];

  type MatrixRow = (typeof rows)[number];

  function buildMatrixFs(row: MatrixRow): MemFs {
    const fs = new MemFs({ lenient: true });
    for (const f of row.folders) {
      fs.file(`${sessionsDir}/${f.folder}/SESSION.md`, `# SESSION — ${f.folder}\n`);
      if (f.closed === true) fs.file(`${sessionsDir}/${f.folder}/.closed`, "");
    }
    const contextId = row.request.contextId;
    if (row.bound !== undefined && contextId !== undefined) {
      const bindings = { [hashContextId(contextId)]: row.bound };
      fs.file(`${sessionsDir}/.bindings.json`, `${JSON.stringify({ version: 1, bindings })}\n`);
    }
    return fs;
  }

  function assertOutcome(
    result: Awaited<ReturnType<typeof resolveSessionTarget>>,
    expected: MatrixRow["expect"],
  ): void {
    if ("folder" in expected) {
      if (result.outcome !== "resolved") {
        throw new Error(`expected ${expected.folder}, got ${result.code}: ${result.message}`);
      }
      expect(result.session.folder).toBe(expected.folder);
      return;
    }
    if (result.outcome === "resolved") {
      throw new Error(`expected ${expected.code}, resolved ${result.session.folder}`);
    }
    expect(result.code).toBe(expected.code);
    expect(result.action.length).toBeGreaterThan(0);
  }

  it.each(rows.map((r) => [r.name, r] as const))("%s", async (_name, row) => {
    const fs = buildMatrixFs(row);
    const before = fs.writes.size;
    const result = await resolveSessionTarget(fs, paths, { intent: "read", ...row.request });
    assertOutcome(result, row.expect);
    // Resolution alone never mutates: `bind` is off in every row here.
    expect(fs.writes.size).toBe(before);
  });
});
