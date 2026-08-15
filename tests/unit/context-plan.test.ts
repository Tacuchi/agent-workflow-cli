import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadManifest } from "../../src/application/context/manifest.js";
import { runContextPlan } from "../../src/application/context/plan-service.js";
import { NodeFileSystem } from "../helpers/real-fs.js";

const REPO_ROOT = resolve(__dirname, "..", "..");
const BUNDLE_ROOT = join(REPO_ROOT, "skills", "w");
const COMMANDS_ROOT = join(BUNDLE_ROOT, "commands");
const BASELINE_PATH = join(REPO_ROOT, "tests", "fixtures", "context-baseline.json");
const CONTEXT_SRC = join(REPO_ROOT, "src", "application", "context");

const fs = new NodeFileSystem();

describe("context-plan — the resolver returns what the doctrine already orders read", () => {
  // F2's phase proof, and what survives of it.
  //
  // At F2 the resolver had to return a read-set byte-identical to the doctrine's
  // — with the bundle unrestructured, that equality was the evidence it invented
  // nothing. F3 and F4 then deliberately made those documents smaller, so the
  // BYTES are no longer expected to match. The frozen documents remain exact,
  // except for explicitly approved new core modules, while the budget stays green.
  it("reaches the baseline read-set for all 18 commands, unsignalled, at no greater cost", async () => {
    const baseline = JSON.parse(await readFile(BASELINE_PATH, "utf8"));
    const frozen = new Map<string, { bytes: number; files: string[] }>(
      baseline.guaranteed.map((g: { command: string; bytes: number; files: string[] }) => [
        g.command,
        { bytes: g.bytes, files: g.files },
      ]),
    );
    expect(frozen.size).toBe(16);
    for (const [command, expected] of frozen) {
      const plan = await runContextPlan(fs, { command, root: BUNDLE_ROOT });
      const additions = ["plan-new", "plan-refine", "plan-exec"].includes(command)
        ? ["modules/PLAN-EXECUTION-BATCHES.md"]
        : [];
      const insertAt = expected.files.indexOf("loops/CHASSIS.md");
      const expectedFiles =
        additions.length === 0 || insertAt === -1
          ? expected.files
          : [...expected.files.slice(0, insertAt), ...additions, ...expected.files.slice(insertAt)];
      expect(
        plan.read_set.map((e) => e.path),
        command,
      ).toEqual(expectedFiles);
      expect(plan.bytes, command).toBeLessThanOrEqual(expected.bytes);
      expect(plan.degraded, command).toBe(false);
      expect(plan.profile, command).toBe("compact");
    }
  });

  it("every authored command pins context-plan to the Claude plugin bundle token", async () => {
    const rootArg = '--root "${CLAUDE_PLUGIN_ROOT}/skills/w"';
    const commandFiles = (await readdir(COMMANDS_ROOT))
      .filter((name) => name.endsWith(".md") && name !== "README.md")
      .sort();
    expect(commandFiles).toHaveLength(18);

    const offenders: string[] = [];
    for (const file of commandFiles) {
      const lines = (await readFile(join(COMMANDS_ROOT, file), "utf8"))
        .split(/\r?\n/)
        .filter((line) => line.includes("aw context-plan --command"));
      if (lines.length === 0) offenders.push(`${file}: missing context-plan call`);
      for (const line of lines) {
        if (!line.includes(rootArg)) offenders.push(`${file}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("a signalled invocation adds its module and nothing else", async () => {
    const bare = await runContextPlan(fs, { command: "plan-exec", root: BUNDLE_ROOT });
    // plan-exec loads only its checkout DB doctrine: remote data is deliberately
    // not a capability of this loop.
    const withDb = await runContextPlan(fs, {
      command: "plan-exec",
      signals: ["db"],
      root: BUNDLE_ROOT,
    });
    const added = withDb.read_set.filter((e) => !bare.read_set.some((b) => b.path === e.path));
    expect(added.length).toBeGreaterThan(0);
    expect(added.every((e) => e.kind === "module" && e.signal === "db")).toBe(true);
    expect(withDb.bytes).toBeGreaterThan(bare.bytes);
    expect(withDb.degraded).toBe(false);
    // The core is untouched and still first: the hard floor never ends up
    // behind a conditional module.
    expect(withDb.read_set.slice(0, bare.read_set.length).map((e) => e.path)).toEqual(
      bare.read_set.map((e) => e.path),
    );
  });

  it("a case without DB or UI loads neither, and the receipt shows it", async () => {
    const plan = await runContextPlan(fs, { command: "plan-exec", root: BUNDLE_ROOT });
    expect(plan.receipt.loaded.some((p) => /DB|SQL/i.test(p))).toBe(false);
    expect(plan.receipt.loaded.some((p) => /DESIGN-SPECS/i.test(p))).toBe(false);
    expect(plan.receipt.signals).toEqual([]);
  });

  it("hands back absolute paths: the agent opens them without re-deriving anything", async () => {
    const plan = await runContextPlan(fs, { command: "quick", root: BUNDLE_ROOT });
    for (const entry of plan.read_set) {
      expect(entry.absolute.startsWith(BUNDLE_ROOT), entry.path).toBe(true);
      expect(entry.absolute.endsWith(entry.path.replace(/\//g, "/"))).toBe(true);
    }
  });

  it("reports zero reference hops: one call, N documents at the same level", async () => {
    const plan = await runContextPlan(fs, { command: "plan-exec", root: BUNDLE_ROOT });
    expect(plan.receipt.reference_hops).toBe(0);
    expect(plan.receipt.loaded).toHaveLength(plan.read_set.length);
  });

  it("emits the receipt as command output, never as something the agent asserts", async () => {
    const plan = await runContextPlan(fs, { command: "spec-refine", root: BUNDLE_ROOT });
    expect(plan.receipt.command).toBe("spec-refine");
    expect(plan.receipt.profile).toBe("compact");
    expect(plan.receipt.bytes).toBe(plan.bytes);
    expect(plan.receipt.telemetry).toBe("local-only");
    expect(plan.receipt.tokens.available).toBe(false);
    expect(plan.receipt.fallback.used).toBe(false);
  });

  it("names the tree it resolved against, so a receipt cannot describe another bundle", async () => {
    const plan = await runContextPlan(fs, { command: "status", root: BUNDLE_ROOT });
    expect(plan.receipt.root).toBe(BUNDLE_ROOT);
    expect(plan.receipt.root_origin).toBe("explicit");
  });

  it("fails on an unknown command with the list of the ones it does know", async () => {
    await expect(runContextPlan(fs, { command: "ghost", root: BUNDLE_ROOT })).rejects.toThrow(
      /no está en el manifiesto/,
    );
  });

  it("requires a command instead of guessing one", async () => {
    await expect(runContextPlan(fs, { command: "", root: BUNDLE_ROOT })).rejects.toThrow(
      /--command es obligatorio/,
    );
  });
});

describe("context-plan — a half-updated install degrades, and says so once", () => {
  /** A bundle copy whose manifest names a module the tree does not carry. */
  async function bundleWithGhostModule(tmp: string): Promise<string> {
    const manifest = JSON.parse(
      await readFile(join(BUNDLE_ROOT, "context", "MANIFEST.json"), "utf8"),
    );
    manifest.commands.status.modules = [{ path: "modules/ghost.md", signal: "db" }];
    await fs.mkdirp(join(tmp, "context"));
    await fs.mkdirp(join(tmp, "commands"));
    await fs.writeText(join(tmp, "context", "MANIFEST.json"), JSON.stringify(manifest, null, 2));
    await fs.writeText(
      join(tmp, "commands", "status.md"),
      await readFile(join(BUNDLE_ROOT, "commands", "status.md"), "utf8"),
    );
    return tmp;
  }

  it("returns the profile marked degraded instead of failing on a missing module", async () => {
    const tmp = join(REPO_ROOT, "node_modules", ".tmp-context-plan-ghost");
    await fs.remove(tmp);
    const root = await bundleWithGhostModule(tmp);
    try {
      const plan = await runContextPlan(fs, { command: "status", signals: ["db"], root });
      expect(plan.degraded).toBe(true);
      expect(plan.profile).toBe("safe");
      // The command still answers: a half-finished update is a normal state,
      // and the safe reading of it is more context, not an error.
      expect(plan.read_set.some((e) => e.path === "commands/status.md")).toBe(true);
      expect(plan.read_set.find((e) => e.path === "modules/ghost.md")?.missing).toBe(true);
      expect(plan.notice).toMatch(/perfil seguro/);
      expect(plan.receipt.fallback.used).toBe(true);
      // The receipt lists what was LOADED — a document that is not there was not.
      expect(plan.receipt.loaded).not.toContain("modules/ghost.md");
    } finally {
      await fs.remove(tmp);
    }
  });

  it("widens to the full profile for a signal this bundle does not know", async () => {
    const plan = await runContextPlan(fs, {
      command: "quick",
      signals: ["a-signal-from-a-newer-workline"],
      root: BUNDLE_ROOT,
    });
    expect(plan.degraded).toBe(true);
    expect(plan.profile).toBe("safe");
    expect(plan.notice).toMatch(/a-signal-from-a-newer-workline/);
  });

  it("says the degradation once, with its cause and its impact", async () => {
    const plan = await runContextPlan(fs, {
      command: "quick",
      signals: ["ghost"],
      root: BUNDLE_ROOT,
    });
    expect(plan.notice).not.toBeNull();
    expect(plan.notice).toMatch(/Impacto/);
    // One notice, not one per reason: the user is told once.
    expect((plan.notice ?? "").match(/Contexto ampliado/g)).toHaveLength(1);
  });
});

describe("context resolution — capabilities, never host names", () => {
  // Spec 010 inherits this surface. A branch keyed on a host name is exactly the
  // hard-wired condition that would make it inherit a bug instead.
  const HOST_NAMES = [
    "claude",
    "codex",
    "warp",
    "gemini",
    "opencode",
    "crush",
    "antigravity",
    "cursor",
  ];

  it("no module under src/application/context branches on a host name", async () => {
    const offenders: string[] = [];
    for (const name of await readdir(CONTEXT_SRC)) {
      if (!name.endsWith(".ts")) continue;
      const text = (await readFile(join(CONTEXT_SRC, name), "utf8")).toLowerCase();
      for (const host of HOST_NAMES) {
        if (text.includes(host)) offenders.push(`${name}: mentions '${host}'`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the manifest declares signals about the task, not about who is running it", async () => {
    const manifest = await loadManifest(fs, BUNDLE_ROOT);
    const offenders = Object.keys(manifest.signals).filter((signal) =>
      HOST_NAMES.some((host) => signal.toLowerCase().includes(host)),
    );
    expect(offenders).toEqual([]);
  });
});

describe("profile selection — capabilities and evidence, never a host name", () => {
  it("stays compact when nothing says the compact route cannot deliver", async () => {
    const plan = await runContextPlan(fs, {
      command: "spec-refine",
      signals: ["shape"],
      root: BUNDLE_ROOT,
    });
    expect(plan.profile).toBe("compact");
    expect(plan.notice).toBeNull();
    expect(plan.receipt.fallback.used).toBe(false);
  });

  it("reports an unmet capability WITHOUT widening: it changes what the run can do, not what it reads", async () => {
    const plan = await runContextPlan(fs, {
      command: "spec-refine",
      signals: ["web"],
      root: BUNDLE_ROOT,
    });
    // The read-set is the compact one — the module concerned already says how
    // to degrade, so loading every unrelated branch would be a penalty for a
    // capability the host never had.
    expect(plan.profile).toBe("compact");
    expect(plan.degraded).toBe(true);
    expect(plan.notice).toMatch(/web-research/);
    expect(plan.notice).toMatch(/sin ampliar/);
    expect(plan.read_set.some((e) => e.path.endsWith("IDEATION-GATE.md"))).toBe(true);
    expect(plan.read_set.some((e) => e.path.endsWith("PLAN-MODE.md"))).toBe(false);
  });

  it("widens to the FULL profile only when the signal set itself cannot be trusted", async () => {
    const manifest = await loadManifest(fs, BUNDLE_ROOT);
    const plan = await runContextPlan(fs, {
      command: "spec-refine",
      signals: ["a-signal-from-a-newer-workline"],
      root: BUNDLE_ROOT,
    });
    expect(plan.profile).toBe("safe");
    const declared = manifest.commands["spec-refine"];
    expect(plan.read_set).toHaveLength(
      (declared?.core.length ?? 0) + (declared?.modules.length ?? 0),
    );
  });

  it("stays compact once that same capability is declared", async () => {
    const compact = await runContextPlan(fs, {
      command: "spec-refine",
      signals: ["web"],
      capabilities: ["web-research"],
      root: BUNDLE_ROOT,
    });
    expect(compact.profile).toBe("compact");
    expect(compact.notice).toBeNull();
    expect(compact.receipt.capabilities).toEqual(["web-research"]);
    expect(compact.degraded).toBe(false);
    // Declaring the capability costs nothing extra: same read-set, no notice.
    const undeclared = await runContextPlan(fs, {
      command: "spec-refine",
      signals: ["web"],
      root: BUNDLE_ROOT,
    });
    expect(compact.bytes).toBe(undeclared.bytes);
    expect(undeclared.degraded).toBe(true);
  });

  it("a capability is only required by the modules the signals actually pulled in", async () => {
    // `db` modules require external-data, but an unsignalled run never reaches
    // them — so it must not be forced into the fallback by a branch it skipped.
    const plan = await runContextPlan(fs, { command: "quick", root: BUNDLE_ROOT });
    expect(plan.profile).toBe("compact");
  });

  it("is stable: the same input gives the same profile, every time", async () => {
    const once = await runContextPlan(fs, {
      command: "plan-exec",
      signals: ["db", "probe"],
      root: BUNDLE_ROOT,
    });
    for (let i = 0; i < 3; i += 1) {
      const again = await runContextPlan(fs, {
        command: "plan-exec",
        signals: ["probe", "db"], // same set, different order
        root: BUNDLE_ROOT,
      });
      expect(again.profile).toBe(once.profile);
      expect(again.read_set.map((e) => e.path)).toEqual(once.read_set.map((e) => e.path));
      expect(again.bytes).toBe(once.bytes);
    }
  });

  it("says the degradation exactly once, with its cause and its impact", async () => {
    const plan = await runContextPlan(fs, {
      command: "plan-exec",
      signals: ["db", "compaction"],
      root: BUNDLE_ROOT,
    });
    expect(plan.degraded).toBe(true);
    const notice = plan.notice ?? "";
    // DB no longer asks for remote data; only compaction is unavailable.
    expect(plan.receipt.fallback.reasons.length).toBe(1);
    expect(notice.match(/^Contexto (ampliado|degradado)/g)).toHaveLength(1);
    expect(notice).toMatch(/Impacto/);
    // It never asks the user to pick a profile.
    expect(notice).not.toMatch(/eleg[ií]|seleccion|opci[oó]n/i);
  });

  it("every capability the manifest requires is one HARNESS.md declares", async () => {
    const manifest = await loadManifest(fs, BUNDLE_ROOT);
    const harness = await readFile(join(BUNDLE_ROOT, "harness", "HARNESS.md"), "utf8");
    const required = new Set<string>();
    for (const entry of Object.values(manifest.commands)) {
      for (const module of entry.modules) {
        if (module.requires !== undefined) required.add(module.requires);
      }
    }
    expect(required.size).toBeGreaterThan(0);
    for (const capability of required) {
      expect(harness, `HARNESS.md must declare '${capability}'`).toContain(capability);
    }
  });
});

describe("signal discoverability — a module nothing routes to is a module nothing loads", () => {
  it("every invocation advertises the signals that command accepts", async () => {
    const plan = await runContextPlan(fs, { command: "status", root: BUNDLE_ROOT });
    expect(plan.available_signals.map((s) => s.signal)).toContain("plan-mode");
    for (const entry of plan.available_signals) {
      expect(entry.means.length, entry.signal).toBeGreaterThan(0);
      expect(entry.module).toMatch(/^modules\//);
    }
  });

  it("every module in the manifest is reachable from its own command's advertisement", async () => {
    const manifest = await loadManifest(fs, BUNDLE_ROOT);
    const unreachable: string[] = [];
    for (const command of Object.keys(manifest.commands)) {
      const plan = await runContextPlan(fs, { command, root: BUNDLE_ROOT });
      const advertised = new Set(plan.available_signals.map((s) => s.module));
      for (const module of manifest.commands[command]?.modules ?? []) {
        if (!advertised.has(module.path)) unreachable.push(`${command} → ${module.path}`);
      }
    }
    expect(unreachable).toEqual([]);
  });

  /**
   * A module nobody routes to is dead weight — with ONE exception, and it is the
   * opposite case: a **tombstone** exists so an old link lands somewhere that
   * says "do not follow", which means it must NOT be in anybody's read-set.
   * Routing one delivers bytes whose only instruction is to ignore them.
   *
   * The exemption is earned by the FILE declaring itself retired, never by being
   * listed here, so it cannot cover a live module. The test below proves the
   * predicate discriminates.
   */
  const RETIRED_MARKER = "DO NOT FOLLOW THIS MODULE";

  async function modulesOnDisk(): Promise<string[]> {
    return (await fs.list(join(BUNDLE_ROOT, "modules")))
      .filter((e) => e.type === "file" && e.name.endsWith(".md"))
      .map((e) => `modules/${e.name}`);
  }

  async function declaredModules(): Promise<Set<string>> {
    const manifest = await loadManifest(fs, BUNDLE_ROOT);
    const declared = new Set<string>();
    for (const entry of Object.values(manifest.commands)) {
      for (const path of entry.core) {
        if (path.startsWith("modules/")) declared.add(path);
      }
      for (const module of entry.modules) declared.add(module.path);
    }
    return declared;
  }

  it("no module in the tree is orphaned, unless it is a tombstone that says so", async () => {
    const declared = await declaredModules();
    const onDisk = await modulesOnDisk();
    expect(onDisk.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const path of onDisk.filter((p) => !declared.has(p))) {
      const text = await fs.readText(join(BUNDLE_ROOT, path));
      if (!text.includes(RETIRED_MARKER)) offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });

  it("and the exemption is earned by the file: no routed module carries the marker", async () => {
    // Without this the rule above would be vacuous the moment the marker leaked
    // into live doctrine — every module would exempt itself.
    const declared = await declaredModules();
    const leaked: string[] = [];
    for (const path of await modulesOnDisk()) {
      if (!declared.has(path)) continue;
      const text = await fs.readText(join(BUNDLE_ROOT, path));
      if (text.includes(RETIRED_MARKER)) leaked.push(path);
    }
    expect(leaked).toEqual([]);
  });
});
