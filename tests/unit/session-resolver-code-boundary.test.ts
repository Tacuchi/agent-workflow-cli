import { describe, expect, it } from "vitest";
import { PathsService } from "../../src/application/paths-service.js";
import { resolveSession } from "../../src/application/session-resolver.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
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

describe("resolveSession — numeric code word-boundary", () => {
  // Reachable once a workspace passes 999 sessions: the global counter emits
  // 4-digit prefixes that coexist with old 3-digit folders. A bare `startsWith`
  // makes code "100" fuzzy-match "1000-…" (folders are scanned high→low), so the
  // wrong session resolves silently.
  it("resolves a 3-digit code to its own folder, not a longer-numbered one", async () => {
    const fs = buildFs(["100-target-quick", "1000-decoy-quick"]);
    const entry = await resolveSession(fs, new FakeEnv("/home/u", "/cwd"), paths, "100");
    expect(entry?.folder).toBe("100-target-quick");
  });

  it("still resolves an exact full folder name", async () => {
    const fs = buildFs(["100-target-quick", "1000-decoy-quick"]);
    const entry = await resolveSession(
      fs,
      new FakeEnv("/home/u", "/cwd"),
      paths,
      "1000-decoy-quick",
    );
    expect(entry?.folder).toBe("1000-decoy-quick");
  });

  it("still resolves a descriptor prefix up to a dash boundary", async () => {
    const fs = buildFs(["002-correo-otp-spec-refine", "003-correo-plan-new"]);
    const entry = await resolveSession(fs, new FakeEnv("/home/u", "/cwd"), paths, "002-correo-otp");
    expect(entry?.folder).toBe("002-correo-otp-spec-refine");
  });

  it("does not fuzzy-match a numeric code across a dash boundary (abbreviated code)", async () => {
    // "01" must not silently resolve to "012-…"; an incomplete numeric code is
    // ambiguous and should miss rather than pick the highest-numbered folder.
    const fs = buildFs(["010-a-quick", "011-b-quick", "012-c-quick"]);
    const entry = await resolveSession(fs, new FakeEnv("/home/u", "/cwd"), paths, "01");
    expect(entry).toBeNull();
  });
});

describe("resolveSession — type fallback by folder suffix (SESSION.md without ## Type)", () => {
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
    const entry = await resolveSession(
      slimFs(folder),
      new FakeEnv("/home/u", "/cwd"),
      paths,
      folder,
    );
    expect(entry?.type).toBe(expected);
  });

  it("unknown suffix leaves type absent (as before)", async () => {
    const entry = await resolveSession(
      slimFs("009-libre"),
      new FakeEnv("/home/u", "/cwd"),
      paths,
      "009-libre",
    );
    expect(entry?.type).toBeUndefined();
  });

  it("a legacy ## Type section still wins over the suffix", async () => {
    const fs = new FakeFs({ lenient: true });
    fs.file(
      `${sessionsDir}/010-x-plan-exec/SESSION.md`,
      "# SESSION — 010-x-plan-exec\n\n## Type\nquick\n",
    );
    const entry = await resolveSession(
      fs,
      new FakeEnv("/home/u", "/cwd"),
      paths,
      "010-x-plan-exec",
    );
    expect(entry?.type).toBe("quick");
  });
});
