import { describe, expect, it } from "vitest";
import { PathsService } from "../../src/application/paths-service.js";
import { hashContextId } from "../../src/application/session-binding-service.js";
import {
  type SessionResolution,
  resolveSessionTarget,
} from "../../src/application/session-resolver.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { MemFs as FakeFs } from "../helpers/mem-fs.js";

const paths = new PathsService(normalizeNamespace("workflow"), "/home/u", "/cwd");
const sessionsDir = "/cwd/.workflow/sessions";
const bindingsFile = `${sessionsDir}/.bindings.json`;

interface Seed {
  folder: string;
  closed?: boolean;
}

function buildFs(seeds: Seed[]): FakeFs {
  const fs = new FakeFs({ lenient: true });
  for (const seed of seeds) {
    fs.file(`${sessionsDir}/${seed.folder}/SESSION.md`, `# SESSION — ${seed.folder}\n`);
    if (seed.closed === true) fs.file(`${sessionsDir}/${seed.folder}/.closed`, "");
  }
  return fs;
}

function withBindings(fs: FakeFs, entries: Record<string, string>): FakeFs {
  const bindings: Record<string, string> = {};
  for (const [contextId, folder] of Object.entries(entries)) {
    bindings[hashContextId(contextId)] = folder;
  }
  fs.file(bindingsFile, `${JSON.stringify({ version: 1, bindings }, null, 2)}\n`);
  return fs;
}

function expectError(result: SessionResolution) {
  if (result.outcome !== "resolved") return result;
  throw new Error(`expected an error, resolved ${result.session.folder} via ${result.via}`);
}

function expectResolved(result: SessionResolution) {
  if (result.outcome === "resolved") return result;
  throw new Error(`expected a session, got ${result.code}: ${result.message}`);
}

describe("resolveSessionTarget — identity formats", () => {
  const seeds: Seed[] = [{ folder: "044-continuidad-plan-exec" }, { folder: "session007-legacy" }];

  it.each([
    ["current numeric code", "44"],
    ["current padded code", "044"],
    ["current folder name", "044-continuidad-plan-exec"],
    ["current descriptor prefix", "044-continuidad"],
  ])("%s resolves the current-model folder", async (_label, code) => {
    const result = await resolveSessionTarget(buildFs(seeds), paths, { code });
    expect(expectResolved(result).session.folder).toBe("044-continuidad-plan-exec");
  });

  it.each([
    ["legacy numeric code", "7"],
    ["legacy padded code", "007"],
    ["legacy prefixed code", "session007"],
    ["legacy folder name", "session007-legacy"],
  ])("%s resolves the legacy folder", async (_label, code) => {
    const result = await resolveSessionTarget(buildFs(seeds), paths, { code });
    expect(expectResolved(result).session.folder).toBe("session007-legacy");
  });

  it("a code matching both layouts is ambiguous, never 'the first one'", async () => {
    const fs = buildFs([{ folder: "007-current" }, { folder: "session007-legacy" }]);
    const result = expectError(await resolveSessionTarget(fs, paths, { code: "007" }));
    expect(result.code).toBe("SESSION_AMBIGUOUS");
    expect(result.candidates.map((c) => c.folder).sort()).toEqual([
      "007-current",
      "session007-legacy",
    ]);
  });
});

describe("resolveSessionTarget — precedence", () => {
  const twoActive: Seed[] = [{ folder: "020-vieja-quick" }, { folder: "044-nueva-plan-exec" }];

  it("an explicit identity wins over the conversation's binding", async () => {
    const fs = withBindings(buildFs(twoActive), { "conv-a": "020-vieja-quick" });
    const result = await resolveSessionTarget(fs, paths, { code: "044", contextId: "conv-a" });
    expect(expectResolved(result).session.folder).toBe("044-nueva-plan-exec");
    expect(expectResolved(result).via).toBe("explicit");
  });

  // The regression this plan exists for: `--code 044` was skipped while 020 was
  // also active, because the private checkpoint resolvers only knew `sessionNNN-*`.
  it("an explicit current-model code is not made ambiguous by another active session", async () => {
    const result = await resolveSessionTarget(buildFs(twoActive), paths, { code: "044" });
    expect(expectResolved(result).session.folder).toBe("044-nueva-plan-exec");
  });

  it("an invalid explicit identity ENDS the resolution — it never falls back", async () => {
    const fs = withBindings(buildFs(twoActive), { "conv-a": "020-vieja-quick" });
    const result = expectError(
      await resolveSessionTarget(fs, paths, { code: "999", contextId: "conv-a" }),
    );
    expect(result.code).toBe("SESSION_NOT_FOUND");
    expect(result.action.length).toBeGreaterThan(0);
  });

  it("with no explicit identity, the durable binding wins over any ordering", async () => {
    const fs = withBindings(buildFs(twoActive), { "conv-a": "020-vieja-quick" });
    const result = await resolveSessionTarget(fs, paths, { contextId: "conv-a" });
    expect(expectResolved(result).session.folder).toBe("020-vieja-quick");
    expect(expectResolved(result).via).toBe("binding");
  });

  it("two conversations keep distinct lines over the same workspace", async () => {
    const fs = withBindings(buildFs(twoActive), {
      "conv-a": "020-vieja-quick",
      "conv-b": "044-nueva-plan-exec",
    });
    const a = await resolveSessionTarget(fs, paths, { contextId: "conv-a" });
    const b = await resolveSessionTarget(fs, paths, { contextId: "conv-b" });
    expect(expectResolved(a).session.folder).toBe("020-vieja-quick");
    expect(expectResolved(b).session.folder).toBe("044-nueva-plan-exec");
  });

  it("several active sessions and no binding is ambiguous, never chosen by age", async () => {
    const result = expectError(await resolveSessionTarget(buildFs(twoActive), paths, {}));
    expect(result.code).toBe("SESSION_AMBIGUOUS");
    expect(result.candidates.map((c) => c.folder).sort()).toEqual([
      "020-vieja-quick",
      "044-nueva-plan-exec",
    ]);
  });

  it("the sole active session is the fallback — a closed one never counts as it", async () => {
    const fs = buildFs([{ folder: "020-vieja-quick", closed: true }, { folder: "044-sola-quick" }]);
    const result = await resolveSessionTarget(fs, paths, {});
    expect(expectResolved(result).session.folder).toBe("044-sola-quick");
    expect(expectResolved(result).via).toBe("sole_active");
  });

  it("no active session at all reports not-found with the closed ones as candidates", async () => {
    const fs = buildFs([{ folder: "020-vieja-quick", closed: true }]);
    const result = expectError(await resolveSessionTarget(fs, paths, {}));
    expect(result.code).toBe("SESSION_NOT_FOUND");
    expect(result.candidates).toEqual([
      { folder: "020-vieja-quick", code: "020", state: "closed" },
    ]);
  });
});

describe("resolveSessionTarget — closed sessions", () => {
  const seeds: Seed[] = [{ folder: "044-cerrada-plan-exec", closed: true }];

  it("an explicit closed target is refused by default", async () => {
    const result = expectError(await resolveSessionTarget(buildFs(seeds), paths, { code: "044" }));
    expect(result.code).toBe("SESSION_CLOSED");
    expect(result.action).toMatch(/--reopen/);
  });

  it("allowClosed lets read and close paths reach it", async () => {
    const result = await resolveSessionTarget(buildFs(seeds), paths, {
      code: "044",
      allowClosed: true,
    });
    expect(expectResolved(result).session.folder).toBe("044-cerrada-plan-exec");
  });
});

describe("resolveSessionTarget — registry failures fail closed", () => {
  const seeds: Seed[] = [{ folder: "044-sola-quick" }];

  it("a binding pointing at a removed folder never redirects to the sole active one", async () => {
    const fs = withBindings(buildFs(seeds), { "conv-a": "020-desaparecida-quick" });
    const result = expectError(await resolveSessionTarget(fs, paths, { contextId: "conv-a" }));
    expect(result.code).toBe("SESSION_BINDING_INVALID");
    expect(result.message).toMatch(/020-desaparecida-quick/);
  });

  it("a binding pointing at a closed folder never redirects either", async () => {
    const fs = withBindings(buildFs([...seeds, { folder: "020-cerrada-quick", closed: true }]), {
      "conv-a": "020-cerrada-quick",
    });
    const result = expectError(await resolveSessionTarget(fs, paths, { contextId: "conv-a" }));
    expect(result.code).toBe("SESSION_BINDING_INVALID");
  });

  it.each([
    ["truncated JSON", '{"version":1,"bindings":{'],
    ["unknown version", '{"version":2,"bindings":{}}'],
    ["bindings is not a map", '{"version":1,"bindings":[]}'],
    ["non-string value", '{"version":1,"bindings":{"abc":42}}'],
  ])("%s fails closed and is never overwritten", async (_label, raw) => {
    const fs = buildFs(seeds);
    fs.file(bindingsFile, raw);
    const result = expectError(await resolveSessionTarget(fs, paths, { contextId: "conv-a" }));
    expect(result.code).toBe("SESSION_BINDING_INVALID");
    expect(await fs.readText(bindingsFile)).toBe(raw);
  });

  it("an absent registry is simply unbound: the sole-active fallback still applies", async () => {
    const result = await resolveSessionTarget(buildFs(seeds), paths, { contextId: "conv-a" });
    expect(expectResolved(result).via).toBe("sole_active");
  });
});
