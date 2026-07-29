import { describe, expect, it } from "vitest";
import { PathsService } from "../../src/application/paths-service.js";
import {
  type SessionResolution,
  resolveSessionTarget,
} from "../../src/application/session-resolver.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { MemFs as FakeFs } from "../helpers/mem-fs.js";

const paths = new PathsService(normalizeNamespace("workflow"), "/home/u", "/cwd");
const sessionsDir = "/cwd/.workflow/sessions";

/** Build a FakeFs whose sessions dir holds the given (all-active) folders. */
function buildFs(folders: string[]): FakeFs {
  const fs = new FakeFs({ lenient: true });
  for (const folder of folders) {
    fs.file(`${sessionsDir}/${folder}/SESSION.md`, `# SESSION — ${folder}\n\n## Type\nquick\n`);
  }
  return fs;
}

function resolved(result: SessionResolution) {
  if (result.outcome !== "resolved") {
    throw new Error(`expected a resolved session, got ${result.code}: ${result.message}`);
  }
  return result;
}

describe("resolveSessionTarget — numeric code word-boundary", () => {
  // Reachable once a workspace passes 999 sessions: the global counter emits
  // 4-digit prefixes that coexist with old 3-digit folders. A bare `startsWith`
  // makes code "100" fuzzy-match "1000-…", so the wrong session resolves silently.
  it("resolves a 3-digit code to its own folder, not a longer-numbered one", async () => {
    const fs = buildFs(["100-target-quick", "1000-decoy-quick"]);
    const result = await resolveSessionTarget(fs, paths, { code: "100" });
    expect(resolved(result).session.folder).toBe("100-target-quick");
    expect(resolved(result).via).toBe("explicit");
  });

  it("still resolves an exact full folder name", async () => {
    const fs = buildFs(["100-target-quick", "1000-decoy-quick"]);
    const result = await resolveSessionTarget(fs, paths, { code: "1000-decoy-quick" });
    expect(resolved(result).session.folder).toBe("1000-decoy-quick");
  });

  it("still resolves a descriptor prefix up to a dash boundary", async () => {
    const fs = buildFs(["002-correo-otp-spec-refine", "003-correo-plan-new"]);
    const result = await resolveSessionTarget(fs, paths, { code: "002-correo-otp" });
    expect(resolved(result).session.folder).toBe("002-correo-otp-spec-refine");
  });

  it("does not fuzzy-match a numeric code across a dash boundary (abbreviated code)", async () => {
    // "01" normalizes to "001" and must not silently resolve to "012-…".
    const fs = buildFs(["010-a-quick", "011-b-quick", "012-c-quick"]);
    const result = await resolveSessionTarget(fs, paths, { code: "01" });
    expect(result.outcome).toBe("error");
    if (result.outcome !== "error") return;
    expect(result.code).toBe("SESSION_NOT_FOUND");
    expect(result.candidates.map((c) => c.folder)).toEqual([
      "010-a-quick",
      "011-b-quick",
      "012-c-quick",
    ]);
  });
});

describe("resolveSessionTarget — type fallback by folder suffix (SESSION.md without ## Type)", () => {
  // New-model SESSION.md no longer renders ## Type; the resolver derives it
  // from the descriptor's <slug>-<flow> suffix. Legacy artifacts with the
  // section keep winning (buildFs above renders ## Type and stays covered).
  function slimFs(folder: string): FakeFs {
    const fs = new FakeFs({ lenient: true });
    fs.file(
      `${sessionsDir}/${folder}/SESSION.md`,
      `# SESSION — ${folder}\n\n## Objective\nx\n\n## Success criteria\n- [ ]\n`,
    );
    return fs;
  }

  it.each([
    ["004-otp-spec-refine", "refine"],
    ["005-otp-plan-new", "refine"],
    ["006-otp-plan-refine", "refine"],
    ["007-otp-plan-exec", "exec"],
    ["008-otp-quick", "quick"],
  ])("%s → type %s", async (folder, expected) => {
    const result = await resolveSessionTarget(slimFs(folder), paths, { code: folder });
    expect(resolved(result).session.type).toBe(expected);
  });

  it("unknown suffix leaves type absent (as before)", async () => {
    const result = await resolveSessionTarget(slimFs("009-libre"), paths, { code: "009-libre" });
    expect(resolved(result).session.type).toBeUndefined();
  });

  it("a legacy ## Type section still wins over the suffix", async () => {
    const fs = new FakeFs({ lenient: true });
    fs.file(
      `${sessionsDir}/010-x-plan-exec/SESSION.md`,
      "# SESSION — 010-x-plan-exec\n\n## Type\nquick\n",
    );
    const result = await resolveSessionTarget(fs, paths, { code: "010-x-plan-exec" });
    expect(resolved(result).session.type).toBe("quick");
  });
});
