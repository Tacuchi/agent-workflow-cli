// Permission profiles of the host run (plan 085, T1.3, AC-04): each allows
// edit+exec for an allowlist only and denies every AC-04 operation under a deny
// decision of its own files; a profile missing a denial is rejected before it
// reaches any home. Merges never overwrite what `self install` wrote.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { staleBuildInputs } from "../../scripts/host-run/freshness.mjs";
import { COVERED_HOSTS } from "../../scripts/host-run/hosts.mjs";
import {
  Cleanup,
  applyProfileFile,
  describeStep,
  isInside,
  nodeFs,
  planIsolation,
  prepareHost,
  prepareStep,
  productionDeps,
  resolveReal,
  rotatedCredentials,
  sourcesOutside,
  staleRoots,
  stripToolGrants,
  toolGrants,
  workspaceGuard,
} from "../../scripts/host-run/isolation.mjs";
import { guardSource } from "../../scripts/host-run/profiles/crush.mjs";
import {
  CLAUDE_SHELL_ALLOW,
  DENIAL_IDS,
  validateProfile,
} from "../../scripts/host-run/profiles/denials.mjs";
import {
  PROFILES,
  loadProfiles,
  mergeJson,
  mergeToml,
  renderedText,
} from "../../scripts/host-run/profiles/index.mjs";
import {
  homeGlobs,
  kimiRuleProblems,
  permissionEntries,
} from "../../scripts/host-run/profiles/kimi.mjs";
import { STEERING_FILES } from "../../scripts/host-run/profiles/steering.mjs";

const ctx = { home: "/tmp/h", workspace: "/tmp/w", node: "node" };

/** The checkout's production dependency closure, as run.mjs computes it (package-lock.json). */
function checkoutDeps(): string[] {
  const checkout = join(__dirname, "..", "..");
  return productionDeps(readFileSync(join(checkout, "package-lock.json"), "utf8"), (rel: string) =>
    existsSync(join(checkout, rel)),
  );
}

/**
 * picomatch as kimi calls it (`isMatch(value, pattern)`, default options). It is
 * a transitive dev dependency (vite/vitest), resolved explicitly: if it is not
 * installed this THROWS and the test fails, it never passes vacuously.
 */
function picomatchAsKimi(): (value: string, pattern: string) => boolean {
  const pm = createRequire(import.meta.url)("picomatch");
  return (value, pattern) => pm.isMatch(value, pattern);
}

describe("host-run permission profiles", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("there is one profile per covered host", () => {
    expect(Object.keys(PROFILES).sort()).toEqual([...COVERED_HOSTS].sort());
  });

  it("the AC-04 minimum is the spec's list", () => {
    expect(DENIAL_IDS).toEqual([
      "push",
      "tag",
      "publish",
      "global-install",
      "force",
      "rm-rf",
      "release-create",
      "pr-create",
      "repo-create",
      "remote-add",
      "version-change",
    ]);
  });

  for (const [host, profile] of Object.entries(PROFILES)) {
    it(`${host}: every AC-04 denial sits under a deny decision of its own files`, () => {
      const files = profile.files(ctx);
      expect(files.length).toBeGreaterThan(0);
      expect(validateProfile(profile, files)).toEqual([]);
    });

    it(`${host}: never pre-approves a whole shell`, () => {
      const allowed = profile.allowedIn(profile.files(ctx));
      for (const wholesale of ["Bash", "bash", "*", "Bash(*)", "command(*)", '["bash"]']) {
        expect(allowed, `${host} allows ${wholesale}`).not.toContain(wholesale);
      }
      expect(JSON.stringify(profile.files(ctx))).not.toMatch(/git -C/);
    });
  }

  it("a profile missing a denial is rejected, and so is the whole set", () => {
    const base = PROFILES["claude-code"];
    const broken = { ...base, denials: base.denials.filter((d) => d.category !== "push") };
    expect(validateProfile(broken, broken.files(ctx))).toContain(
      "claude-code: no denial for 'push'",
    );
    expect(() => loadProfiles({ ...PROFILES, "claude-code": broken }, ctx)).toThrow(
      /no denial for 'push'/,
    );
  });

  it("a denial written under an allow decision, or not written at all, is rejected", () => {
    const base = PROFILES["claude-code"];
    const flipped = {
      ...base,
      files: () => {
        const [file] = base.files(ctx);
        const { allow, deny } = file.value.permissions;
        return [{ ...file, value: { permissions: { allow: deny, deny: allow } } }];
      },
    };
    const problems = validateProfile(flipped, flipped.files());
    expect(problems.some((p) => p.includes("is not under a deny decision"))).toBe(true);
    expect(problems.some((p) => p.includes("is also allowed"))).toBe(true);
    const lying = { ...PROFILES.opencode, files: () => [] };
    expect(validateProfile(lying, []).some((p) => p.includes("not under a deny decision"))).toBe(
      true,
    );
  });

  it("a profile that does not allow edit or exec is rejected", () => {
    const base = PROFILES.kimi;
    const problems = validateProfile({ ...base, allowsExec: false }, base.files(ctx));
    expect(problems).toContain("kimi: does not allow executing");
  });

  it("claude scopes edits to the workspace and allows the Workline MCP execute_sql", () => {
    const allow = PROFILES["claude-code"].effective(ctx).allow;
    expect(allow).toContain("mcp__host-run-probe__execute_sql");
    expect(allow).toContain("Edit(//tmp/w/**)");
    expect(allow).not.toContain("Edit");
  });

  it("opencode asks for every command and edit, and denies after the catch-all", () => {
    const { bash, edit } = PROFILES.opencode.effective();
    const keys = Object.keys(bash);
    expect(keys[0]).toBe("*");
    expect(bash["*"]).toBe("ask");
    expect(edit).toBe("ask");
    expect(Object.values(bash).filter((v) => v === "allow")).toEqual([]);
    expect(bash["git push*"]).toBe("deny");
  });

  it("no profile pre-approves a shell command (claude: only its Workline list and `pwd`)", () => {
    for (const [host, profile] of Object.entries(PROFILES)) {
      const shell = profile
        .allowedIn(profile.files(ctx))
        .filter((r: string) => /^(Bash|bash|command)(\(|:|$)/.test(r));
      expect(shell.sort(), host).toEqual(
        host === "claude-code" ? [...CLAUDE_SHELL_ALLOW].sort() : [],
      );
    }
    const leaky = { ...PROFILES.kimi, allowedIn: () => ["Bash(aw *)"] };
    expect(validateProfile(leaky, leaky.files(ctx))).toContain(
      "kimi: pre-approves shell commands ('Bash(aw *)')",
    );
  });

  it("kimi's denials match anywhere in a command, across `/`, `&&` and `;` (picomatch as kimi calls it)", () => {
    const picomatch = picomatchAsKimi();
    const denies = PROFILES.kimi
      .deniedIn(PROFILES.kimi.files(ctx))
      .map((r: string) => r.slice(5, -1));
    const denied = (cmd: string) => denies.some((glob: string) => picomatch(cmd, glob));
    for (const cmd of [
      "git push",
      "git push origin feature/x",
      "git add -A && git commit -m x && git push",
      "mkdir x && npm publish",
      "cat a; cd ..; git push",
      "rm -rf /tmp/x",
      "cd /w && npm i --force",
    ]) {
      expect(denied(cmd), cmd).toBe(true);
    }
    for (const cmd of ["git status", "ls -la /tmp", "aw doctor"])
      expect(denied(cmd), cmd).toBe(false);
  });

  it("codex runs under the hostrun permission profile and kimi is kept out of auto mode", () => {
    const codex = renderedText(PROFILES.codex.files({ ...ctx, realHome: "/Users/someone" }));
    // Profiles do not compose with the legacy sandbox settings: none of them is written.
    expect(codex).not.toContain("sandbox_mode");
    expect(codex).not.toContain("[sandbox_workspace_write]");
    expect(codex).toContain('default_permissions = "hostrun"');
    expect(codex).toContain("[permissions.hostrun]\ndescription = ");
    expect(codex).toContain('extends = ":workspace"');
    expect(codex).toContain("[permissions.hostrun.network]\nenabled = false");
    expect(codex).toContain(
      '[permissions.hostrun.filesystem]\n"/Users/someone" = "deny"\n":slash_tmp" = "deny"',
    );
    expect(renderedText(PROFILES.kimi.files(ctx))).toContain('default_permission_mode = "manual"');
  });

  it("merging JSON keeps what self install wrote and appends the profile", () => {
    const installed = {
      hooks: { PreToolUse: [{ matcher: "mcp__.*__execute_sql" }] },
      mcp: { x: 1 },
    };
    const merged = mergeJson(installed, {
      hooks: { PreToolUse: [{ matcher: "^bash$" }] },
      permissions: { allowed_tools: ["view"] },
    });
    expect(merged).toEqual({
      hooks: { PreToolUse: [{ matcher: "mcp__.*__execute_sql" }, { matcher: "^bash$" }] },
      mcp: { x: 1 },
      permissions: { allowed_tools: ["view"] },
    });
  });

  it("merging TOML puts top-level keys first, tables last, and refuses a key already there", () => {
    const installed = '[mcp_servers.host-run-probe]\ncommand = "agent-workflow"\n';
    const top = mergeToml(installed, {
      kind: "toml-top",
      value: 'sandbox_mode = "workspace-write"',
    });
    expect(top.startsWith('sandbox_mode = "workspace-write"\n[mcp_servers')).toBe(true);
    const table = mergeToml(top, { kind: "toml-table", value: "[permission]\ndeny = []" });
    expect(table.trimEnd().endsWith("[permission]\ndeny = []")).toBe(true);
    expect(() => mergeToml(top, { kind: "toml-top", value: 'sandbox_mode = "read-only"' })).toThrow(
      /conflicts/,
    );
    expect(() =>
      mergeToml(table, { kind: "toml-table", value: "[permission]\nallow = []" }),
    ).toThrow(/conflicts/);
  });

  it("the crush guard denies AC-04 in any segment — newlines included — and never pre-approves", () => {
    const dir = mkdtempSync(join(tmpdir(), "host-run-guard-"));
    dirs.push(dir);
    const guard = join(dir, "guard.mjs");
    writeFileSync(guard, guardSource());
    const run = (cmd: string) =>
      spawnSync(process.execPath, [guard], {
        env: { CRUSH_TOOL_INPUT_COMMAND: cmd },
        encoding: "utf8",
      });
    for (const denied of [
      "git push",
      "git push origin main",
      "ls && git tag v1",
      "ls\nnpm publish",
      "git commit -m a\nrm -rf /",
      "git status\r\ngit push",
      "echo $(git push)",
      "(cd x; npm version patch)",
      "npm install -g x",
      "npm i --force",
      "gh pr create --fill",
      "git remote add origin x",
      "aw self update",
    ]) {
      expect(run(denied).status, JSON.stringify(denied)).toBe(2);
    }
    // Everything else: no opinion, so crush asks the person. Nothing is ever pre-approved.
    for (const other of [
      "git status",
      "ls -la",
      "aw doctor",
      "mkdir /etc/x",
      "git diff --output=/x",
    ]) {
      const r = run(other);
      expect(r.status, other).toBe(0);
      expect(r.stdout, other).toBe("");
    }
    expect(guardSource()).not.toContain('"decision":"allow"');
  });
});

describe("host-run isolation", () => {
  const root = "/tmp/fake/aw-host-run-r1-codex-AbC123";
  const plan = (hostId: string) =>
    planIsolation({
      hostId,
      root,
      checkout: "/checkout",
      node: "/usr/local/bin/node",
      nodeDir: "/usr/local/bin",
      hostBin: `/opt/bin/${hostId}`,
      realHome: "/Users/someone",
      profile: PROFILES[hostId],
      model: "m1",
      effort: "high",
      deps: ["node_modules/pg"],
    });

  it("the clean env points only inside the disposable home and never inherits host config", () => {
    const env = plan("codex").env;
    expect(Object.keys(env).sort()).toEqual(
      [
        "CODEX_HOME",
        "CRUSH_GLOBAL_DATA",
        "HOME",
        "KIMI_CODE_HOME",
        "LANG",
        "PATH",
        "TERM",
        "TMPDIR",
        "XDG_CONFIG_HOME",
      ].sort(),
    );
    for (const k of [
      "HOME",
      "CODEX_HOME",
      "KIMI_CODE_HOME",
      "XDG_CONFIG_HOME",
      "CRUSH_GLOBAL_DATA",
    ]) {
      expect(env[k as keyof typeof env], k).toMatch(new RegExp(`^${root}/home`));
    }
    expect(env.PATH.split(":")[0]).toBe(`${root}/bin`);
    expect(env).not.toHaveProperty("OPENCODE_CONFIG");
    expect(env).not.toHaveProperty("CLAUDE_CONFIG_DIR");
    expect(env).not.toHaveProperty("AW_MCP_PROBE");
    expect(env).not.toHaveProperty("CRUSH_GLOBAL_CONFIG");
    expect(env.TMPDIR).toBe(`${root}/tmp`);
  });

  it("the pane runs env -i with the absolute host binary, its profile args and model/effort", () => {
    const cmd = plan("gemini").pane.command;
    expect(cmd.startsWith("env -i HOME=")).toBe(true);
    // agy takes its key through its wrapper, so the pane launches the wrapper.
    expect(cmd).toContain(` ${root}/bin/launch-gemini --model m1 --effort high`);
    expect(cmd).not.toContain("accept-edits");
    expect(plan("codex").pane.command).toContain(
      "/opt/bin/codex -m m1 -c model_reasoning_effort=high",
    );
  });

  it("every file the plan writes, and every copy destination, is inside the disposable root", () => {
    for (const host of COVERED_HOSTS) {
      const p = plan(host);
      const targets = [
        ...p.shims.map((s) => s.path),
        p.dsnFile.path,
        ...p.steps.flatMap((s) =>
          s.kind === "profile"
            ? s.files.map((f) => join(p.home, f.path))
            : s.kind === "credentials"
              ? s.copies.map((c) => c.to)
              : [],
        ),
        ...p.steps.filter((s) => "cwd" in s).map((s) => (s as { cwd: string }).cwd),
      ];
      for (const t of targets) expect(t.startsWith(`${root}/`), `${host}: ${t}`).toBe(true);
      expect(p.steps.map((s) => s.kind)).toContain("auth-probe");
    }
  });

  it("registers the MCP through use-env then a global forced setup, with an unreachable DSN", () => {
    const p = plan("kimi");
    const aw = p.steps
      .filter((s) => s.kind === "aw")
      .map((s) => (s as { args: string[] }).args.join(" "));
    expect(aw).toContain("self mcp use-env --name host-run-probe --dsn-var HOST_RUN_PROBE_DSN");
    expect(aw).toContain("mcp setup --host kimi --instance host-run-probe --global --force");
    expect(p.dsnFile.source).toMatch(/^HOST_RUN_PROBE_DSN=postgresql:\/\/127\.0\.0\.1:9\//);
  });

  it("the shims log which binary ran, then exec the root's copy of the checkout CLI", () => {
    const shim = plan("claude-code").shims[0]?.source ?? "";
    expect(shim).toContain("shim-calls.log");
    // The root's own node and its own copy of the checkout CLI, never the real HOME's.
    expect(shim).toContain(`exec ${root}/bin/node ${root}/cli/dist/cli/main.js`);
  });

  it("prepareHost writes only through the injected fs, under the root, and stops at the first failure", () => {
    const writes: string[] = [];
    const fs = {
      mkdir: (p: string) => writes.push(p),
      writeFile: (p: string) => writes.push(p),
      readFile: () => "",
      exists: () => false,
      listFiles: () => [],
      realpath: (path: string) => path,
      symlink: (_target: string, path: string) => writes.push(path),
      linkOrCopy: (_from: string, to: string) => writes.push(to),
      treeHash: () => "same",
      copyPackage: () => {},
      packagesHash: () => "deps",
      copy: (_f: string, t: string) => writes.push(t),
    };
    const calls: string[] = [];
    const run = (cmd: string, args: string[]) => {
      calls.push(`${cmd} ${args.join(" ")}`);
      return { status: args.includes("setup") ? 1 : 0, stdout: "", stderr: "" };
    };
    const log = prepareHost(plan("opencode"), {
      fs,
      run,
      cliMain: "/checkout/dist/cli/main.js",
      node: "node",
    });
    expect(log.at(-1)).toMatchObject({ ok: false });
    expect(calls.some((c) => c.includes("workspace-init"))).toBe(false);
    for (const w of writes) expect(w.startsWith(`${root}/`), w).toBe(true);
  });

  it("a copied credential that changed during the run is reported, never copied back", () => {
    const p = plan("codex");
    const stamps: Record<string, string> = {};
    const writes: string[] = [];
    const fs = {
      mkdir: () => {},
      writeFile: () => {},
      readFile: () => "",
      exists: (path: string) =>
        path === "/Users/someone/.codex/auth.json" || path.endsWith("/node_modules"),
      listFiles: () => [],
      realpath: (path: string) => path,
      symlink: (_target: string, path: string) => writes.push(path),
      linkOrCopy: (_from: string, to: string) => writes.push(to),
      treeHash: () => "same",
      copyPackage: () => {},
      packagesHash: () => "deps",
      copy: (_from: string, to: string) => {
        stamps[to] = "10:1";
      },
      stamp: (path: string) => stamps[path] ?? "missing",
    };
    const run = () => ({ status: 0, stdout: "", stderr: "" });
    prepareHost(p, { fs, run, cliMain: "/checkout/dist/cli/main.js", node: "node" });
    expect(rotatedCredentials(p, fs.stamp)).toEqual([]);
    stamps[`${root}/home/.codex/auth.json`] = "12:2";
    expect(rotatedCredentials(p, fs.stamp)).toEqual([
      { to: `${root}/home/.codex/auth.json`, rel: ".codex/auth.json" },
    ]);
    expect(p.steps.map(describeStep).join("\n")).toMatch(/may rotate.*never overwritten/);
  });

  it("sweeps only recognizable roots whose run is dead", () => {
    const entries = [
      { name: "aw-host-run-r0-codex-x", path: "/t/aw-host-run-r0-codex-x" },
      { name: "aw-host-run-r1-kimi-y", path: "/t/aw-host-run-r1-kimi-y" },
      { name: "other-dir", path: "/t/other-dir" },
    ];
    const markers: Record<string, { pid: number } | null> = {
      "/t/aw-host-run-r0-codex-x": { pid: 1 },
      "/t/aw-host-run-r1-kimi-y": { pid: 2 },
    };
    const stale = staleRoots(
      entries,
      (p: string) => markers[p] ?? null,
      (pid: number) => pid === 2,
    );
    expect(stale).toEqual(["/t/aw-host-run-r0-codex-x"]);
  });

  it("cleanup removes every root once on a signal, even if a hook throws", () => {
    const removed: string[] = [];
    const signals: string[] = [];
    const cleanup = new Cleanup(
      (p: string) => removed.push(p),
      (s: string) => signals.push(s),
    );
    cleanup.track("/t/a");
    cleanup.track("/t/b");
    cleanup.addHook(() => {
      throw new Error("herdr gone");
    });
    const handlers: Record<string, () => void> = {};
    const register = (e: string, f: () => void) => {
      handlers[e] = f;
    };
    cleanup.install({ on: register, once: register });
    handlers.SIGHUP?.();
    handlers.exit?.();
    expect(removed).toEqual(["/t/a", "/t/b"]);
    expect(signals).toEqual(["SIGHUP"]);
  });
});

describe("host-run profiles — third review", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("kimi writes every rule as a table its schema accepts, never as a bare string", () => {
    const text = renderedText(PROFILES.kimi.files(ctx));
    const deny = permissionEntries(text, "deny");
    expect(deny.length).toBe(PROFILES.kimi.denials.length);
    for (const entry of deny) {
      expect(kimiRuleProblems(entry), JSON.stringify(entry)).toEqual([]);
      expect(entry.scope).toBe("user");
      expect(entry.pattern.startsWith("Bash(")).toBe(true);
    }
    expect(permissionEntries(text, "allow")).toEqual([]);
    // What the old profile wrote — bare strings — is exactly what kimi drops.
    const old = '[permission]\ndeny = [\n  "Bash(git status*)",\n]\nallow = []';
    expect(kimiRuleProblems(permissionEntries(old, "deny")[0])).toEqual([
      'not an inline table: "Bash(git status*)",',
    ]);
  });

  it("kimi's globs cross newlines, and catch a dotted last segment (picomatch as kimi calls it)", () => {
    const isMatch = picomatchAsKimi();
    const globs = PROFILES.kimi
      .deniedIn(PROFILES.kimi.files(ctx))
      .map((r: string) => r.slice(5, -1));
    const denied = (cmd: string) => globs.some((g: string) => isMatch(cmd, g));
    const gp = ["git", "push"].join(" ");
    for (const cmd of [
      `ls\n${gp}`,
      `${gp}\nls`,
      "rm -rf ./.git",
      "rm -rf .git",
      "rm -rf /tmp/.cache",
    ]) {
      expect(denied(cmd), JSON.stringify(cmd)).toBe(true);
    }
    // Declared gap: several dotted segments are not matched (the command still asks).
    expect(denied("rm -rf /a/.b/.c/d")).toBe(false);
    expect(PROFILES.kimi.limitations.join(" ")).toMatch(/dotted segments/);
  });

  it("detects codex allow rules and a crush guard that could pre-approve, by structure", () => {
    const codex = PROFILES.codex;
    const allowRule = {
      path: ".codex/rules/default.rules",
      kind: "text",
      value: "prefix_rule(pattern=[\"ls\"], decision = 'allow')\n",
    };
    expect(
      validateProfile(codex, [...codex.files(ctx), allowRule]).some((p) =>
        p.includes("pre-approves shell"),
      ),
    ).toBe(true);
    const crush = PROFILES.crush;
    for (const leak of [
      "console.log(JSON.stringify({ decision: 'allow' }))",
      "process.stdout.write('{}')",
    ]) {
      const files = crush
        .files(ctx)
        .map((f: { path: string; value: unknown }) =>
          f.path.endsWith("deny-guard.mjs") ? { ...f, value: `${f.value}\n${leak}` } : f,
        );
      expect(
        validateProfile(crush, files).some((p) => p.includes("pre-approves shell")),
        leak,
      ).toBe(true);
    }
  });

  it("the merged files — over a synthetic self-install in a disposable HOME — still validate", () => {
    const home = mkdtempSync(join(tmpdir(), "host-run-merge-"));
    dirs.push(home);
    const installed: Record<string, string> = {
      ".claude/settings.json": JSON.stringify({
        hooks: { PreToolUse: [{ matcher: "mcp__.*__execute_sql" }] },
      }),
      ".codex/config.toml": '[mcp_servers.host-run-probe]\ncommand = "agent-workflow"\n',
      ".kimi-code/config.toml":
        '[[hooks]]\nevent = "PreToolUse"\ncommand = "agent-workflow hook sql-mutation-guard"\n',
      ".config/crush/crush.json": JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: "x", command: "agent-workflow hook sql-mutation-guard" }],
        },
        mcp: {},
      }),
      ".config/opencode/opencode.json": JSON.stringify({ mcp: { "host-run-probe": {} } }),
    };
    const fsPort = {
      exists: (p: string) => existsSync(p),
      readFile: (p: string) => readFileSync(p, "utf8"),
      writeFile: (p: string, text: string) => {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, text);
      },
    };
    for (const [rel, text] of Object.entries(installed)) fsPort.writeFile(join(home, rel), text);
    const mergeCtx = { home, workspace: join(home, "ws"), node: "node" };
    for (const [host, profile] of Object.entries(PROFILES)) {
      const files = profile.files(mergeCtx);
      for (const f of files) applyProfileFile(fsPort, f, home);
      const merged = files.map((f: { path: string; kind: string }) => {
        const text = readFileSync(join(home, f.path), "utf8");
        return { ...f, value: f.kind === "json" ? JSON.parse(text) : text };
      });
      expect(validateProfile(profile, merged), host).toEqual([]);
    }
    // What self install wrote survives the merge.
    expect(readFileSync(join(home, ".kimi-code/config.toml"), "utf8")).toContain("[[hooks]]");
    expect(
      JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8")).hooks,
    ).toBeDefined();
  });

  it("claude pre-approves exactly the scenario's Workline calls, and nothing broader passes", () => {
    const allowed = PROFILES["claude-code"].allowedIn(PROFILES["claude-code"].files(ctx));
    const shell = allowed.filter((r: string) => r.startsWith("Bash("));
    expect(shell.sort()).toEqual([...CLAUDE_SHELL_ALLOW].sort());
    for (const words of [
      "self",
      "mcp setup",
      "git-flow",
      "reset",
      "discard",
      "amend",
      "persist",
      "workspace-init",
    ]) {
      expect(
        shell.some((r: string) => r.startsWith(`Bash(aw ${words}`)),
        words,
      ).toBe(false);
    }
    const ask = PROFILES["claude-code"].effective(ctx).ask;
    expect(ask).toContain("Bash(aw *--workspace*)");
    expect(ask).toContain("Bash(aw doctor apply:*)");
    for (const broad of ["Bash(aw:*)", "Bash(aw *)", "Bash(agent-workflow:*)"]) {
      const leaky = { ...PROFILES["claude-code"], allowedIn: () => [...allowed, broad] };
      expect(validateProfile(leaky, leaky.files(ctx)), broad).toContain(
        `claude-code: pre-approves shell commands ('${broad}')`,
      );
    }
  });
});

describe("host-run — fourth review", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const quickWrapper = `---
description: quick
argument-hint: <task>
allowed-tools:
  [
    "Bash",
    "Read",
    "Write",
    "Edit",
  ]
---

# quick
Run aw flow start.
`;

  it("strips a wrapper's allowed-tools grant and leaves the rest byte for byte", () => {
    expect(toolGrants(quickWrapper)).toEqual(["Bash", "Read", "Write", "Edit"]);
    const stripped = stripToolGrants(quickWrapper);
    expect(toolGrants(stripped)).toEqual([]);
    expect(stripped).toContain("description: quick\nargument-hint: <task>\n");
    expect(stripped.endsWith("---\n\n# quick\nRun aw flow start.\n")).toBe(true);
    expect(stripToolGrants("no frontmatter\nallowed-tools: [Bash]\n")).toBe(
      "no frontmatter\nallowed-tools: [Bash]\n",
    );
    expect(toolGrants("---\nallowed-tools: Bash, Edit\n---\n")).toEqual(["Bash", "Edit"]);
  });

  it.skipIf(!existsSync(join(__dirname, "..", "..", "dist", "cli", "main.js")))(
    "a real self install into a disposable HOME, then the strip step: no installed file grants a tool",
    () => {
      const home = mkdtempSync(join(tmpdir(), "host-run-grants-"));
      dirs.push(home);
      const cli = join(__dirname, "..", "..", "dist", "cli", "main.js");
      for (const target of ["claude", "codex", "gemini", "opencode", "crush", "kimi"]) {
        const r = spawnSync(
          process.execPath,
          [cli, "self", "install", "--target", target, "--force"],
          {
            env: { PATH: process.env.PATH, HOME: home },
            cwd: home,
            encoding: "utf8",
          },
        );
        expect(r.status, `${target}: ${r.stderr}`).toBe(0);
      }
      const walk = (dir: string): string[] =>
        readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
          e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
        );
      const granting = () =>
        walk(home).filter(
          (f) => f.endsWith(".md") && toolGrants(readFileSync(f, "utf8")).length > 0,
        );
      // The product finding: the installed wrappers grant tools, claude's own commands included.
      expect(granting().some((f) => f.includes("/.claude/commands/w/quick.md"))).toBe(true);
      const fsPort = {
        listFiles: walk,
        readFile: (p: string) => readFileSync(p, "utf8"),
        writeFile: (p: string, text: string) => writeFileSync(p, text),
      };
      const plan = planIsolation({
        hostId: "claude-code",
        root: dirname(home),
        checkout: "/checkout",
        node: "node",
        nodeDir: "/usr/bin",
        hostBin: "/opt/bin/claude",
        realHome: "/Users/someone",
        profile: PROFILES["claude-code"],
      });
      const strip = {
        ...plan.steps.find((s: { kind: string }) => s.kind === "strip-grants"),
        dir: home,
      };
      const outcome = prepareStep(strip, { fs: fsPort });
      expect(outcome.ok, outcome.detail).toBe(true);
      expect(granting()).toEqual([]);
    },
    120_000,
  );

  it("the strip and sources-guard steps are part of the plan the digest seals", () => {
    const p = planIsolation({
      hostId: "claude-code",
      root: "/tmp/r",
      checkout: "/c",
      node: "node",
      nodeDir: "/usr/bin",
      hostBin: "/opt/bin/claude",
      realHome: "/Users/someone",
      profile: PROFILES["claude-code"],
    });
    const kinds = p.steps.map((s: { kind: string }) => s.kind);
    expect(kinds.indexOf("strip-grants")).toBe(kinds.indexOf("aw") + 1);
    expect(kinds).toContain("sources-guard");
    expect(p.steps.map(describeStep).join("\n")).toMatch(
      /strip the installed wrappers' allowed-tools/,
    );
  });

  it("flags any declared source outside the root", () => {
    const out = (sources: unknown[]) => JSON.stringify({ ok: true, data: { sources } });
    expect(sourcesOutside(out([]), "/r", "/r/workspace")).toEqual([]);
    expect(
      sourcesOutside(
        out([
          { alias: "a", path: "/r/workspace/sub" },
          { alias: "b", path: "sub2" },
        ]),
        "/r",
        "/r/workspace",
      ),
    ).toEqual([]);
    expect(
      sourcesOutside(out([{ alias: "real", path: "/Users/x/Git/repo" }]), "/r", "/r/workspace"),
    ).toEqual(["/Users/x/Git/repo"]);
    expect(sourcesOutside("not json", "/r", "/r/workspace")).toBeNull();
  });

  it("claude asks before editing the files that steer the CLI, and nothing under the real HOME is readable", () => {
    const eff = PROFILES["claude-code"].effective({
      workspace: "/r/ws",
      realHome: "/Users/someone",
    });
    for (const rel of [
      "CLAUDE.md",
      "AGENTS.md",
      ".workflow/workline.json",
      ".git/**",
      ".claude/**",
    ]) {
      expect(eff.ask, rel).toContain(`Edit(//r/ws/${rel})`);
      expect(eff.ask, rel).toContain(`Write(//r/ws/${rel})`);
    }
    expect(eff.allow).toContain("Edit(//r/ws/**)");
    expect(eff.ask.some((r: string) => r.includes(".workflow/sessions"))).toBe(false);
    expect(eff.deny).toContain("Read(//Users/someone/**)");
  });

  it("kimi denies Read/Write/Edit under the real HOME, as tables, and says what it approves by itself", () => {
    const text = renderedText(PROFILES.kimi.files({ realHome: "/Users/someone" }));
    const deny = permissionEntries(text, "deny").map((e: { pattern: string }) => e.pattern);
    for (const tool of ["Read", "ReadMediaFile", "Write", "Edit"])
      expect(deny).toContain(`${tool}(/Users/someone/**)`);
    expect(PROFILES.kimi.limitations.join(" ")).toMatch(
      /approves Write\/Edit inside the git workspace/,
    );
  });

  it("crush's screen is read as the visible screen, not 120 lines of scrollback", async () => {
    const { herdrArgv } = await import("../../scripts/host-run/herdr.mjs");
    expect(herdrArgv.paneRead("w1:p1")).toEqual(["pane", "read", "w1:p1", "--source", "visible"]);
  });
});

describe("host-run — fifth review", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const DIST = join(__dirname, "..", "..", "dist", "cli", "main.js");
  const CHECKOUT = join(__dirname, "..", "..");

  it.skipIf(!existsSync(DIST))(
    "a prepared root runs its own copy of the checkout: read-sets and the MCP descriptor stay inside it",
    () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "host-run-root-")));
      dirs.push(root);
      const plan = planIsolation({
        hostId: "claude-code",
        root,
        checkout: CHECKOUT,
        node: process.execPath,
        hostBin: "/nonexistent/claude",
        realHome: "/Users/someone",
        profile: PROFILES["claude-code"],
        deps: checkoutDeps(),
      });
      const fs = nodeFs();
      const copy = plan.steps.find((s: { kind: string }) => s.kind === "copy-cli");
      const outcome = prepareStep(copy, { fs });
      expect(outcome.ok, outcome.detail).toBe(true);
      expect(copy.treeHash).toBe(copy.checkoutHash);
      expect(copy.treeHash).toMatch(/^[0-9a-f]{64}$/);
      for (const dir of [plan.home, plan.workspace, join(root, "tmp")])
        mkdirSync(dir, { recursive: true });
      const aw = (...args: string[]) =>
        spawnSync(plan.node, [plan.cliMain, ...args], {
          env: plan.env,
          cwd: plan.workspace,
          encoding: "utf8",
        });
      const cp = JSON.parse(aw("context-plan", "--command", "quick").stdout);
      expect(cp.read_set.length).toBeGreaterThan(0);
      for (const entry of cp.read_set)
        expect(entry.absolute.startsWith(`${root}/`), entry.absolute).toBe(true);
      spawnSync("git", ["init", "-q", "-b", "main"], { cwd: plan.workspace, env: plan.env });
      expect(aw("workspace-init").status).toBe(0);
      const started = JSON.parse(
        aw("flow", "start", "--flow", "quick", "--name", "probe", "--objetivo", "x").stdout,
      );
      for (const entry of started.read_set)
        expect(entry.absolute.startsWith(`${root}/`), entry.absolute).toBe(true);
      // The MCP descriptor `mcp setup` would write names the root's node and copy.
      fs.writeFile(plan.dsnFile.path, plan.dsnFile.source);
      expect(
        aw("self", "mcp", "use-env", "--name", "host-run-probe", "--dsn-var", "HOST_RUN_PROBE_DSN")
          .status,
      ).toBe(0);
      aw("mcp", "setup", "--host", "claude", "--instance", "host-run-probe", "--global", "--force");
      const descriptor = readFileSync(join(plan.home, ".claude.json"), "utf8");
      expect(descriptor).toContain(plan.cliMain);
      expect(descriptor).not.toContain(CHECKOUT);
      // node itself is the root's hard link, so no command path lies under the real HOME.
      expect(descriptor).toContain(plan.node);
      expect(descriptor).not.toContain(homedir());
    },
    120_000,
  );

  it("strips and detects the YAML block-list form too", () => {
    const block =
      "---\ndescription: d\nallowed-tools:\n  - Bash\n  - Edit\nargument-hint: x\n---\nbody\n";
    expect(toolGrants(block)).toEqual(["Bash", "Edit"]);
    const stripped = stripToolGrants(block);
    expect(stripped).toBe("---\ndescription: d\nargument-hint: x\n---\nbody\n");
    expect(toolGrants(stripped)).toEqual([]);
    // A leftover item is still a grant.
    expect(toolGrants("---\nallowed-tools:\n  - Bash\n---\n")).toEqual(["Bash"]);
    expect(toolGrants('---\nallowed-tools: ["Bash", "Read"]\n---\n')).toEqual(["Bash", "Read"]);
  });

  it("kimi denies the real HOME's dotfiles and dot directories too (picomatch as kimi's path matcher calls it)", () => {
    const pm = createRequire(import.meta.url)("picomatch");
    const globs = homeGlobs("/Users/someone");
    const denied = (path: string) => globs.some((g) => pm.isMatch(path, g, { nocase: true }));
    for (const path of [
      "/Users/someone/notes.txt",
      "/Users/someone/.zshrc",
      "/Users/someone/.ssh/id_ed25519",
      "/Users/someone/.codex/auth.json",
      "/Users/someone/Git/repo/.env",
      "/Users/someone/a/.b/.c/d",
      "/USERS/SOMEONE/.ssh/x",
    ]) {
      expect(denied(path), path).toBe(true);
    }
    expect(denied("/Users/someoneelse/.ssh/x")).toBe(false);
    const deny = permissionEntries(
      renderedText(PROFILES.kimi.files({ realHome: "/Users/someone" })),
      "deny",
    ).map((e: { pattern: string }) => e.pattern);
    expect(deny).toContain("Read(/Users/someone/**/.*)");
  });

  it("claude and kimi ask before editing every steering file, .workflow/local.json included", () => {
    expect(STEERING_FILES).toContain(".workflow/local.json");
    expect(STEERING_FILES).toContain(".kimi-code/**");
    const claudeAsk = PROFILES["claude-code"].effective({ workspace: "/r/ws" }).ask;
    expect(claudeAsk).toContain("Edit(//r/ws/.workflow/local.json)");
    const ask = permissionEntries(
      renderedText(PROFILES.kimi.files({ workspace: "/r/ws" })),
      "ask",
    ).map((e: { pattern: string }) => e.pattern);
    for (const rel of ["AGENTS.md", "CLAUDE.md", ".workflow/local.json", ".kimi-code/**"]) {
      expect(ask, rel).toContain(`Write(/r/ws/${rel})`);
      expect(ask, rel).toContain(`Edit(/r/ws/${rel})`);
    }
    for (const entry of permissionEntries(
      renderedText(PROFILES.kimi.files({ workspace: "/r/ws" })),
      "ask",
    )) {
      expect(kimiRuleProblems(entry)).toEqual([]);
    }
  });

  it("the workspace guard catches a source or a kimi additional_dir outside the root", () => {
    const none = JSON.stringify({ sources: [] });
    expect(
      workspaceGuard({ root: "/r", workspace: "/r/w", sourcesStdout: none, localToml: null }),
    ).toEqual([]);
    const real = JSON.stringify({ sources: [{ alias: "a", path: "/Users/x/Git/repo" }] });
    expect(
      workspaceGuard({ root: "/r", workspace: "/r/w", sourcesStdout: real, localToml: null }).join(
        " ",
      ),
    ).toMatch(/source points outside/);
    const toml = '[workspace]\nadditional_dir = ["../../elsewhere", "sub"]\n';
    expect(
      workspaceGuard({ root: "/r", workspace: "/r/w", sourcesStdout: none, localToml: toml }).join(
        " ",
      ),
    ).toMatch(/local\.toml adds a directory outside the root: \/elsewhere/);
    expect(
      workspaceGuard({ root: "/r", workspace: "/r/w", sourcesStdout: "junk", localToml: null }),
    ).toEqual(["the workspace's sources cannot be read"]);
  });
});

describe("host-run — sixth review", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const temp = (prefix: string) => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    dirs.push(d);
    return d;
  };

  it("a src file newer than the build refuses the run; a fresh build does not", () => {
    const co = temp("host-run-fresh-");
    mkdirSync(join(co, "src"), { recursive: true });
    mkdirSync(join(co, "dist"), { recursive: true });
    writeFileSync(join(co, "src", "a.ts"), "x");
    writeFileSync(join(co, "package.json"), "{}");
    writeFileSync(join(co, "dist", "dist-manifest.json"), "{}");
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(co, "src", "a.ts"), old, old);
    utimesSync(join(co, "package.json"), old, old);
    expect(staleBuildInputs(co)).toEqual([]);
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(co, "src", "a.ts"), later, later);
    expect(staleBuildInputs(co)).toEqual(["src/a.ts"]);
    rmSync(join(co, "dist", "dist-manifest.json"));
    expect(staleBuildInputs(co)).toEqual(["dist/dist-manifest.json"]);
  });

  it.skipIf(!existsSync(join(__dirname, "..", "..", "dist", "dist-manifest.json")))(
    "the checkout's own dist is not stale after a build (the dist-gated tests rely on it)",
    () => {
      expect(staleBuildInputs(join(__dirname, "..", ".."))).toEqual([]);
    },
  );

  it("paths are compared by their real location: `..`, a symlink and `/root-x` do not pass", () => {
    const base = temp("host-run-real-");
    const root = join(base, "root");
    const ws = join(root, "workspace");
    mkdirSync(ws, { recursive: true });
    mkdirSync(join(base, "outside"));
    symlinkSync(join(base, "outside"), join(ws, "linked"));
    expect(isInside(root, `${ws}/../../outside`)).toBe(false);
    expect(isInside(root, join(ws, "linked"))).toBe(false);
    expect(isInside(root, join(ws, "linked", "not-yet"))).toBe(false);
    expect(isInside(root, `${root}-x/y`)).toBe(false);
    expect(isInside(root, join(ws, "sub", "new-file"))).toBe(true);
    expect(resolveReal("/r/../Users/x")).toBe("/Users/x");
    const S = (sources: unknown[]) => JSON.stringify({ sources });
    expect(
      workspaceGuard({
        root: "/r",
        workspace: "/r/w",
        sourcesStdout: S([{ path: "/r/w/../../etc" }]),
        localToml: null,
      }),
    ).toEqual(["a declared source points outside the root: /etc"]);
    expect(
      workspaceGuard({
        root: "/r",
        workspace: "/r/w",
        sourcesStdout: S([]),
        localToml: 'additional_dir = ["/r/../Users/x"]',
      }),
    ).toEqual([".kimi-code/local.toml adds a directory outside the root: /Users/x"]);
    expect(
      workspaceGuard({
        root,
        workspace: ws,
        sourcesStdout: S([{ path: "linked" }]),
        localToml: null,
      }).length,
    ).toBe(1);
    expect(
      workspaceGuard({
        root: "/r",
        workspace: "/r/w",
        sourcesStdout: S([]),
        localToml: 'additional_dir = ["~/Git"]',
        home: "/r/home",
      }),
    ).toEqual([]);
  });

  it("copy-cli fails, never throws, without node_modules or with a relative host binary; hostbin is created", () => {
    const made: string[] = [];
    const fs = {
      exists: (p: string) => !p.endsWith("node_modules"),
      mkdir: (p: string) => made.push(p),
      copy: () => {},
      symlink: () => {},
      realpath: (p: string) => p,
      linkOrCopy: () => {},
      treeHash: () => "h",
      copyPackage: () => {},
      packagesHash: () => "d",
    };
    const step = (hostBin: string) =>
      planIsolation({
        hostId: "codex",
        root: "/r",
        checkout: "/c",
        node: "/n/node",
        hostBin,
        realHome: "/Users/someone",
        profile: PROFILES.codex,
        deps: ["node_modules/pg"],
      }).steps[0];
    expect(prepareStep(step("/opt/bin/codex"), { fs })).toMatchObject({
      ok: false,
      detail: expect.stringMatching(/no node_modules/),
    });
    const withModules = { ...fs, exists: () => true };
    expect(prepareStep(step("codex"), { fs: withModules })).toMatchObject({
      ok: false,
      detail: expect.stringMatching(/not an absolute/),
    });
    expect(prepareStep(step("/opt/bin/codex"), { fs: withModules }).ok).toBe(true);
    expect(made).toContain("/r/hostbin");
    const described = describeStep(step("/opt/bin/codex"));
    expect(described).toContain("/n/node");
    expect(described).toContain("/opt/bin/codex");
  });

  it("the host instruction files and the doc-branch ledger are steering files", () => {
    for (const rel of [
      "AGENTS.override.md",
      "GEMINI.md",
      ".agent/**",
      "CRUSH.md",
      ".crush/**",
      ".workflow/doc-branches.jsonl",
    ]) {
      expect(STEERING_FILES, rel).toContain(rel);
    }
    expect(PROFILES.kimi.limitations.join(" ")).toMatch(/approve for session/);
  });
});

describe("host-run — seventh review", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const DIST = join(__dirname, "..", "..", "dist", "cli", "main.js");
  const CHECKOUT = join(__dirname, "..", "..");

  it("the production closure comes from package-lock.json: no dev, no devOptional, only installed", () => {
    const lock = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { name: "x" },
        "node_modules/pg": {},
        "node_modules/ink/node_modules/ansi": {},
        "node_modules/vitest": { dev: true },
        "node_modules/fsevents": { devOptional: true },
        "node_modules/absent": {},
      },
    });
    expect(productionDeps(lock, (rel: string) => rel !== "node_modules/absent")).toEqual([
      "node_modules/ink/node_modules/ansi",
      "node_modules/pg",
    ]);
    expect(productionDeps("not json")).toEqual([]);
  });

  it("copy-cli fails without a dependency closure", () => {
    const step = planIsolation({
      hostId: "codex",
      root: "/r",
      checkout: "/c",
      node: "/n/node",
      hostBin: "/opt/bin/codex",
      realHome: "/Users/someone",
      profile: PROFILES.codex,
    }).steps[0];
    const fs = { exists: () => true };
    expect(prepareStep(step, { fs })).toMatchObject({
      ok: false,
      detail: expect.stringMatching(/dependency closure/),
    });
  });

  it.skipIf(!existsSync(DIST))(
    "a prepared root's CLI copy holds no link outside the root and runs with the real HOME unreadable",
    () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "host-run-selfcontained-")));
      dirs.push(root);
      const deps = checkoutDeps();
      expect(deps).toContain("node_modules/pg");
      const plan = planIsolation({
        hostId: "codex",
        root,
        checkout: CHECKOUT,
        node: process.execPath,
        hostBin: "/nonexistent/codex",
        realHome: homedir(),
        profile: PROFILES.codex,
        deps,
      });
      const copy = plan.steps.find((s: { kind: string }) => s.kind === "copy-cli");
      const outcome = prepareStep(copy, { fs: nodeFs() });
      expect(outcome.ok, outcome.detail).toBe(true);
      expect(copy.depsHash).toBe(copy.checkoutDepsHash);
      // Every link under the CLI copy and bin/ resolves inside the root.
      const links: string[] = [];
      const walk = (dir: string) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, e.name);
          if (e.isSymbolicLink()) links.push(p);
          else if (e.isDirectory()) walk(p);
        }
      };
      walk(join(root, "cli"));
      walk(join(root, "bin"));
      for (const link of links) expect(realpathSync(link).startsWith(`${root}/`), link).toBe(true);
      // node + the copy + its dependencies, with the real HOME denied to the process:
      // the same boundary codex's hostrun profile draws (macOS sandbox-exec when present).
      mkdirSync(join(root, "home"), { recursive: true });
      const env = {
        HOME: join(root, "home"),
        PATH: `${join(root, "bin")}:/usr/bin:/bin`,
        TMPDIR: join(root, "home"),
      };
      const args = [plan.node, plan.cliMain, "--version"];
      const sandboxed = existsSync("/usr/bin/sandbox-exec")
        ? spawnSync(
            "/usr/bin/sandbox-exec",
            [
              "-p",
              `(version 1)(allow default)(deny file-read* (subpath "${realpathSync(homedir())}"))`,
              ...args,
            ],
            { env, cwd: root, encoding: "utf8" },
          )
        : spawnSync(args[0], args.slice(1), { env, cwd: root, encoding: "utf8" });
      expect(sandboxed.status, sandboxed.stderr).toBe(0);
      expect(sandboxed.stdout).toMatch(/\d+\.\d+\.\d+/);
    },
    120_000,
  );
});
