// Host tokens of the host run (plan 085, F3 support): claude's OAuth token and
// agy's Gemini API key reach ONLY their host, through a wrapper that reads a
// 0600 file inside the disposable root. They never appear in the dry-run, the
// pane command, the digest, an extract, the matrix, the ledger or a
// notification. `--auth-check` runs the probes only and never touches Herdr.
// Every token here is synthetic.

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUTH_CHECK_WORD,
  PROMPT_PROBES,
  authCheck,
  authOutcome,
} from "../../scripts/host-run/authcheck.mjs";
import {
  containsSecret,
  distinctivePart,
  privacyViolations,
  redactSecrets,
} from "../../scripts/host-run/extract.mjs";
import { COVERED_HOSTS, HOSTS, TOKEN_VARS, tokenSpecs } from "../../scripts/host-run/hosts.mjs";
import {
  Cleanup,
  MARKER_FILE,
  ROOT_GRACE_MS,
  awaitTokenPickup,
  handTokenOver,
  makeRoot,
  nodeFs,
  openPaneWithToken,
  planIsolation,
  prepareStep,
  withoutTokens,
  wrapperSource,
} from "../../scripts/host-run/isolation.mjs";
import { evidenceOf, makeNotifier, sweep } from "../../scripts/host-run/live.mjs";
import { catalogStates } from "../../scripts/host-run/matrix.mjs";
import { PROFILES } from "../../scripts/host-run/profiles/index.mjs";
import { STEPS } from "../../scripts/host-run/scenario.mjs";
import { capabilitiesFor } from "../../src/application/self/host-states.js";
import { HARNESSES } from "../../src/domain/harnesses.js";

const FAKE = "sk-ant-oat01-TEST-not-a-real-token-0000000000000000000000";
const FAKE_AGY = "AIzaTEST-not-a-real-gemini-key-000000";
const RUN = join(__dirname, "..", "..", "scripts", "host-run", "run.mjs");
const DIST = join(__dirname, "..", "..", "dist", "cli", "main.js");

const plan = (hostId: string, root = "/tmp/fake/aw-host-run-r1-x-AbC") =>
  planIsolation({
    hostId,
    root,
    checkout: "/checkout",
    node: "/usr/local/bin/node",
    hostBin: `/opt/bin/${HOSTS[hostId].bin}`,
    realHome: "/Users/someone",
    profile: PROFILES[hostId],
    deps: ["node_modules/pg"],
    tokenPresent: true,
  });

describe("host-run tokens", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const temp = () => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), "host-run-tok-")));
    dirs.push(d);
    return d;
  };

  it("claude reads CLAUDE_CODE_OAUTH_TOKEN, crush a provider key; agy takes none (it signs in in its pane)", () => {
    expect(HOSTS["claude-code"].token.env).toBe("CLAUDE_CODE_OAUTH_TOKEN");
    expect(tokenSpecs("gemini")).toEqual([]);
    expect(HOSTS.gemini.signInInPane).toBe(true);
    expect(tokenSpecs("crush").map((t: { env: string }) => t.env)).toEqual([
      "GEMINI_API_KEY",
      "OPENAI_API_KEY",
    ]);
    // opencode takes an OpenAI key the same way (its catalog: env OPENAI_API_KEY).
    expect(tokenSpecs("opencode").map((t: { env: string }) => t.env)).toEqual(["OPENAI_API_KEY"]);
    for (const id of COVERED_HOSTS.filter(
      (h) => !["claude-code", "crush", "opencode"].includes(h),
    )) {
      expect(tokenSpecs(id), id).toEqual([]);
    }
  });

  it("the token reaches only the wrapper: no env, setup step or pane command carries it", () => {
    for (const id of COVERED_HOSTS) {
      const p = plan(id);
      for (const v of TOKEN_VARS) expect(p.env, `${id} ${v}`).not.toHaveProperty(v);
      expect(JSON.stringify(p.steps), id).not.toContain(FAKE);
      if (tokenSpecs(id).length > 0) {
        expect(p.pane.launchLine, id).toContain(`${p.root}/bin/launch-${HOSTS[id].bin}`);
        for (const t of tokenSpecs(id)) expect(p.pane.launchLine, id).not.toContain(t.env);
        const probe = p.steps.find((s: { kind: string }) => s.kind === "auth-probe");
        expect(probe.bin, id).toBe(p.secret.wrapper);
      } else {
        expect(p.secret, id).toBeNull();
      }
    }
    // `aw mcp setup` (claude mcp list) runs with the plan env: no token.
    const setup = plan("claude-code").steps.find((s: { args?: string[] }) => s.args?.[0] === "mcp");
    expect(setup.kind).toBe("aw");
    expect(
      withoutTokens(
        { A: "1", CLAUDE_CODE_OAUTH_TOKEN: FAKE, GEMINI_API_KEY: FAKE_AGY },
        TOKEN_VARS,
      ),
    ).toEqual({ A: "1" });
  });

  it("the token file is written only at hand-over (0600, dir 0700), the wrapper is 0700, cleanup removes secrets/", () => {
    const root = temp();
    const p = plan("claude-code", root);
    mkdirSync(join(root, "bin"), { recursive: true });
    const step = p.steps.find((s: { kind: string }) => s.kind === "secret");
    const outcome = prepareStep(step, { fs: nodeFs(), secrets: { "claude-code": FAKE } });
    expect(outcome.ok).toBe(true);
    // Preparation writes the wrapper, never the token.
    expect(existsSync(p.secret.path)).toBe(false);
    expect(statSync(join(root, "secrets")).mode & 0o777).toBe(0o700);
    expect(statSync(p.secret.wrapper).mode & 0o777).toBe(0o700);
    const handoff = handTokenOver(nodeFs(), p.secret, FAKE);
    expect(statSync(p.secret.path).mode & 0o777).toBe(0o600);
    // A wrapper that died before its rm -f: the run removes the file and says so.
    expect(handoff?.settle()).toMatch(/removed by the run/);
    expect(existsSync(p.secret.path)).toBe(false);
    expect(handTokenOver(nodeFs(), p.secret, null)).toBeNull();
    handTokenOver(nodeFs(), p.secret, FAKE);
    const cleanup = new Cleanup(
      (d: string) => rmSync(d, { recursive: true, force: true }),
      () => {},
    );
    cleanup.track(root);
    cleanup.run();
    expect(existsSync(join(root, "secrets"))).toBe(false);
  });

  it("the auth probe gets the token file just before it runs, and the file is gone after", async () => {
    const root = temp();
    const p = plan("claude-code", root);
    const probe = p.steps.find((s: { kind: string }) => s.kind === "auth-probe");
    const seen: boolean[] = [];
    const run = () => {
      seen.push(existsSync(p.secret.path));
      return { status: 0, stdout: "", stderr: "" };
    };
    const outcome = await prepareStep(probe, {
      fs: nodeFs(),
      run,
      env: p.env,
      secrets: { "claude-code": FAKE },
    });
    // The fake probe never deletes it (a real wrapper would): the run does, and says so.
    expect(seen).toEqual([true]);
    expect(existsSync(p.secret.path)).toBe(false);
    expect(outcome.detail).toMatch(/removed by the run/);
    expect(outcome.detail).not.toContain(FAKE);
  });

  it("the wrapper deletes the token file right after reading it, exports it only to the host, and never prints it", () => {
    const root = temp();
    const host = join(root, "fake-host");
    // The fake host reports only the LENGTH of what it received, whether the file
    // still exists when it runs, and its args.
    const secret = join(root, "claude.env");
    writeFileSync(
      host,
      `#!/bin/sh\nprintf 'len=%s file=%s args=%s\\n' "\${#CLAUDE_CODE_OAUTH_TOKEN}" "$(test -e '${secret}' && echo yes || echo no)" "$*"\n`,
      { mode: 0o755 },
    );
    writeFileSync(secret, `${FAKE}\n`, { mode: 0o600 });
    const wrapper = join(root, "launch");
    const source = wrapperSource({ var: "CLAUDE_CODE_OAUTH_TOKEN", path: secret, hostBin: host });
    expect(source).not.toMatch(/set -x|echo|printf|>&2|tee/);
    expect(source).toMatch(/read -r[\s\S]*rm -f[\s\S]*exec/);
    writeFileSync(wrapper, source, { mode: 0o700 });
    const r = spawnSync(wrapper, ["auth", "status"], {
      env: { PATH: "/usr/bin:/bin" },
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`len=${FAKE.length} file=no args=auth status\n`);
    expect(`${r.stdout}${r.stderr}`).not.toContain(FAKE);
    expect(existsSync(secret)).toBe(false);
    // Without the file the host runs without the variable: the probe decides.
    expect(
      spawnSync(wrapper, [], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" }).stdout,
    ).toBe("len=0 file=no args=\n");
  });

  it("the privacy filter, the notifier and the transcript refuse the token or its distinctive part", () => {
    const opts = { realHome: "/Users/someone", username: "someone", secrets: [FAKE] };
    const part = distinctivePart(FAKE);
    expect(part).toBe(FAKE.slice("sk-ant-oat01-".length, "sk-ant-oat01-".length + 12));
    expect(privacyViolations({ fragment: `token ${FAKE}` }, opts)).toContain("contains a token");
    expect(privacyViolations({ fragment: `got ${part}…` }, opts)).toContain("contains a token");
    // The shared public prefix identifies nobody.
    expect(privacyViolations({ fragment: "echo sk-ant-oat01-hello" }, opts)).toEqual([]);
    expect(privacyViolations({ fragment: `got ${part.slice(0, 11)}` }, opts)).toEqual([]);
    expect(distinctivePart(FAKE_AGY)).toBe(FAKE_AGY.slice(4, 16));
    expect(containsSecret("x", ["short"])).toBe(false);
    const lines: string[] = [];
    const notify = makeNotifier((l: string) => lines.push(l), [FAKE]);
    notify("claude-code", `auth failed with ${FAKE}`);
    expect(lines.join("")).not.toContain(part);
    expect(lines.join("")).toContain("withheld");
    const redacted = redactSecrets(`screen ${FAKE} and ${part} and sk-ant-oat01-hello`, [FAKE]);
    expect(redacted).not.toContain(part);
    expect(redacted).toContain("sk-ant-oat01-hello");
    expect(redacted).toContain("[redacted]");
  });

  it("claude, kimi and codex deny the other hosts' roots; claude also its own secrets and launcher", () => {
    const ctx = {
      workspace: "/t/me/workspace",
      realHome: "/Users/someone",
      root: "/t/me",
      siblingRoots: ["/t/other"],
      tokenPresent: true,
    };
    const claude = PROFILES["claude-code"].effective(ctx).deny;
    expect(claude).toContain("Read(//t/other/**)");
    expect(claude).toContain("Read(//t/me/secrets/**)");
    expect(claude).toContain("Read(//t/me/bin/launch-*)");
    const kimi = PROFILES.kimi.effective(ctx).deny;
    expect(kimi).toContain("Read(/t/other/**)");
    expect(kimi).toContain("Read(/t/other/**/.*)");
    const codex = JSON.stringify(PROFILES.codex.files(ctx));
    expect(codex).toContain('\\"/t/other\\" = \\"deny\\"');
    for (const id of ["opencode", "crush", "gemini"]) {
      expect(PROFILES[id].limitations.join(" "), id).toMatch(/cannot be path-scoped/);
    }
    expect(PROFILES["claude-code"].limitations.join(" ")).toMatch(
      /CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 is set: per https:\/\/code\.claude\.com\/docs\/en\/env-vars/,
    );
    // Only claude's env carries the scrub switch; it reaches its pane command.
    expect(plan("claude-code").env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe("1");
    expect(plan("claude-code").pane.launchLine).toContain("CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1");
    for (const id of COVERED_HOSTS.filter((h) => h !== "claude-code")) {
      expect(plan(id).env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, id).toBeUndefined();
    }
  });

  it("agy's effective profile says it runs on your own sign-in, done in its pane", () => {
    expect(PROFILES.gemini.effective({ tokenPresent: true }).model_provider).toMatch(
      /your own sign-in, done inside the pane/,
    );
  });

  it("an extract carrying the token is refused and the matrix never holds it", () => {
    const mcp = STEPS.filter((st) => st.surface === "mcp");
    const { matrix, extracts } = evidenceOf(
      {
        runId: "r1",
        date: "2026-09-29",
        cli: { version: "28.0.0", revision: "abc" },
        digest: "d",
        catalog: catalogStates(HARNESSES, capabilitiesFor),
        steps: mcp,
        labels: Object.fromEntries(HARNESSES.map((h) => [h.id, h.label])),
        realHome: "/Users/someone",
        username: "someone",
        secrets: [FAKE],
      },
      [
        {
          id: "claude-code",
          root: "/tmp/r",
          evidence: { mcp: { toolsListed: true, serverReached: true } },
          screensBySurface: { mcp: `execute_sql search_objects ${FAKE}` },
        },
      ],
    );
    expect(extracts).toEqual([]);
    expect(matrix.hosts["claude-code"].cells.mcp.extract_refused).toEqual(["contains a token"]);
    expect(JSON.stringify(matrix)).not.toContain(distinctivePart(FAKE));
  });

  it("agy never gets a key: no modelProvider, no key variable in its env, no wrapper", () => {
    expect(JSON.stringify(PROFILES.gemini.files({ tokenPresent: true }))).not.toContain(
      "modelProvider",
    );
    const p = plan("gemini");
    expect(p.secret).toBeNull();
    for (const v of ["GEMINI_API_KEY", "GOOGLE_API_KEY"]) expect(p.env).not.toHaveProperty(v);
    expect(p.pane.launchLine).not.toMatch(/GEMINI_API_KEY|GOOGLE_API_KEY|launch-/);
    expect(JSON.stringify(p.steps)).not.toMatch(/GEMINI_API_KEY|GOOGLE_API_KEY/);
  });

  it.skipIf(!existsSync(DIST))(
    "the dry-run shows only presence, and the digest seals presence, never the value",
    () => {
      const dir = temp();
      const env = (extra: Record<string, string>) => ({
        PATH: process.env.PATH,
        HOME: join(dir, "home"),
        TMPDIR: join(dir, "tmp"),
        ...extra,
      });
      mkdirSync(join(dir, "home"));
      mkdirSync(join(dir, "tmp"));
      const dry = (extra: Record<string, string>) =>
        spawnSync(process.execPath, [RUN, "--dry-run", "--hosts", "claude-code,gemini"], {
          env: env(extra),
          encoding: "utf8",
        });
      const a = dry({ CLAUDE_CODE_OAUTH_TOKEN: FAKE, GEMINI_API_KEY: FAKE_AGY });
      expect(a.status, a.stderr).toBe(0);
      expect(a.stdout).not.toContain(distinctivePart(FAKE));
      expect(a.stdout).not.toContain(distinctivePart(FAKE_AGY));
      // A GEMINI_API_KEY in the shell is crush's: agy is told to sign in in its pane.
      expect(a.stdout).toContain("agy → sign-in in the pane (you sign in when the run starts)");
      expect(a.stdout).toContain("go to crush only, never to agy");
      expect(a.stdout).not.toMatch(/auth probe: .*agy|modelProvider/);
      expect(a.stdout).toContain(
        "claude token: present (from CLAUDE_CODE_OAUTH_TOKEN; value never shown)",
      );
      const digest = (out: string) => /Approval digest: ([0-9a-f]{12})/.exec(out)?.[1];
      const other = dry({
        CLAUDE_CODE_OAUTH_TOKEN: `${FAKE}-other`,
        GEMINI_API_KEY: `${FAKE_AGY}-other`,
      });
      expect(digest(other.stdout)).toBe(digest(a.stdout));
      const none = dry({});
      expect(none.stdout).toContain("claude token: absent");
      expect(digest(none.stdout)).not.toBe(digest(a.stdout));
      expect(readdirIfExists(join(dir, "tmp"))).toEqual([]);
    },
  );

  it.skipIf(!existsSync(DIST))(
    "a token with a newline, a missing token file, or the removed --agy-token-file: one-line refusals",
    () => {
      const dir = temp();
      mkdirSync(join(dir, "tmp"));
      const base = { PATH: process.env.PATH ?? "", HOME: dir, TMPDIR: join(dir, "tmp") };
      const dry = (argv: string[], extra: Record<string, string> = {}) =>
        spawnSync(process.execPath, [RUN, "--dry-run", ...argv], {
          env: { ...base, ...extra },
          encoding: "utf8",
        });
      const oneLine = (
        r: { status: number | null; stderr: string; stdout: string },
        re: RegExp,
      ) => {
        expect(r.status).toBe(2);
        expect(r.stderr.trim().split("\n")).toHaveLength(1);
        expect(r.stderr).toMatch(re);
        expect(r.stderr).not.toMatch(/at .*\.mjs/);
        expect(`${r.stdout}${r.stderr}`).not.toContain(distinctivePart(FAKE));
      };
      oneLine(dry([], { CLAUDE_CODE_OAUTH_TOKEN: `${FAKE}\nsecond` }), /contains a newline/);
      oneLine(dry(["--claude-token-file", join(dir, "missing")]), /no such file/);
      oneLine(dry(["--agy-token-file", join(dir, "x")]), /--agy-token-file was removed/);
      const blank = dry(["--hosts", "claude-code"], { CLAUDE_CODE_OAUTH_TOKEN: "   " });
      expect(blank.status).toBe(0);
      expect(blank.stdout).toContain("claude token: absent");
      const file = join(dir, "token");
      writeFileSync(file, `  ${FAKE}  \n`, { mode: 0o600 });
      const fromFile = dry(["--hosts", "claude-code", "--claude-token-file", file]);
      expect(fromFile.stdout).toContain(
        "claude token: present (from --claude-token-file; value never shown)",
      );
    },
  );

  it.skipIf(!existsSync(DIST))(
    "run.mjs --auth-check without a TTY refuses and prepares nothing",
    () => {
      const dir = temp();
      mkdirSync(join(dir, "tmp"));
      const r = spawnSync(process.execPath, [RUN, "--auth-check"], {
        env: {
          PATH: process.env.PATH,
          HOME: dir,
          TMPDIR: join(dir, "tmp"),
          CLAUDE_CODE_OAUTH_TOKEN: FAKE,
        },
        encoding: "utf8",
        input: "",
      });
      expect(r.status).toBe(1);
      expect(r.stdout + r.stderr).toMatch(/real terminal/);
      expect(r.stdout + r.stderr).not.toContain(distinctivePart(FAKE));
      expect(readdirIfExists(join(dir, "tmp"))).toEqual([]);
    },
  );
});

function readdirIfExists(dir: string): string[] {
  return existsSync(dir) ? require("node:fs").readdirSync(dir) : [];
}

describe("host-run --auth-check", () => {
  /** A Herdr stand-in that fails the test on ANY use. */
  const herdrTrap = new Proxy(
    {},
    {
      get: () => {
        throw new Error("--auth-check touched Herdr");
      },
    },
  );
  const deps = (over: Record<string, unknown> = {}) => ({
    stdinIsTTY: true,
    stdoutIsTTY: true,
    env: {},
    markers: ["CLAUDECODE", "HERDR_PANE_ID"],
    ancestor: () => null,
    hosts: ["claude-code", "kimi"],
    tokens: { "claude-code": { label: "claude token", state: "present" } },
    ask: vi.fn(async () => AUTH_CHECK_WORD),
    log: vi.fn(),
    prepare: vi.fn(() => [
      { step: "auth probe: /r/bin/launch-claude auth status", ok: true, detail: "authenticated" },
    ]),
    finish: vi.fn(),
    herdr: herdrTrap,
    ...over,
  });

  it("refuses without a TTY, from an agent host, from Herdr, and without the confirmation word", async () => {
    for (const over of [
      { stdinIsTTY: false },
      { env: { CLAUDECODE: "1" } },
      { env: { HERDR_PANE_ID: "w1:p1" } },
      { ancestor: () => "codex (pid 9)" },
      { ask: vi.fn(async () => "yes") },
      { ask: vi.fn(async () => "") },
    ]) {
      const d = deps({ beforePrepare: vi.fn(), ...over });
      expect(await authCheck(d), JSON.stringify(Object.keys(over))).toBe(1);
      expect(d.prepare).not.toHaveBeenCalled();
      // Nothing is swept or created before the confirmation word.
      expect(d.beforePrepare).not.toHaveBeenCalled();
    }
  });

  it("confirmed: runs each host's probe, reports per host, cleans up, and never touches Herdr", async () => {
    const prepare = vi.fn((host: string) =>
      host === "kimi"
        ? [
            { step: "copy the checkout's dist", ok: true, detail: "ok" },
            { step: "auth probe: /opt/kimi -p x", ok: false, detail: "does not authenticate" },
          ]
        : [{ step: "auth probe: launch-claude auth status", ok: true, detail: "authenticated" }],
    );
    const d = deps({ prepare });
    expect(await authCheck(d)).toBe(1);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(d.finish).toHaveBeenCalledTimes(1);
    const out = d.log.mock.calls.map((c) => c[0]).join("\n");
    expect(out).toContain("opens NO Herdr workspace or pane");
    expect(out).toContain("These probes spend one model prompt each: kimi");
    expect(out).toContain("claude token: present (value never shown)");
    expect(out).toMatch(/claude-code\s+authenticated/);
    expect(out).toMatch(/kimi\s+NOT authenticated \(probe failed\)/);
  });

  it("names which probes spend a prompt, and classifies preparation failures by category", () => {
    expect(PROMPT_PROBES.sort()).toEqual(["crush", "gemini", "kimi", "opencode"]);
    expect(
      authOutcome([{ step: "aw mcp setup --host claude --global", ok: false, detail: "exit 1" }]),
    ).toBe("NOT authenticated (preparation failed at: aw mcp setup)");
  });
});

describe("host-run roots under a concurrent sweep", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const temp = () => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), "host-run-sweep-")));
    dirs.push(d);
    return d;
  };
  const rootFs = {
    mkdtemp: (prefix: string) => mkdtempSync(prefix),
    chmod: (path: string, mode: number) => chmodSync(path, mode),
    writeFile: (path: string, text: string, mode: number) => writeFileSync(path, text, { mode }),
  };
  const remove = (p: string) => rmSync(p, { recursive: true, force: true });

  it("a root carries its pid marker from creation, so another terminal's sweep keeps it", () => {
    const tmp = temp();
    const root = makeRoot(rootFs, tmp, "r1", "claude-code");
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(existsSync(join(root, MARKER_FILE))).toBe(true);
    // A second run sweeping now, even long after: this process is alive.
    sweep(tmp, remove, () => {}, Date.now() + 10 * ROOT_GRACE_MS);
    expect(existsSync(root)).toBe(true);
  });

  it("a markerless root is kept during the grace period and swept after it; a dead pid is swept", () => {
    const tmp = temp();
    const young = join(tmp, "aw-host-run-r2-kimi-AbC");
    mkdirSync(young);
    const dead = makeRoot(rootFs, tmp, "r3", "codex", 2 ** 22 + 12345);
    const other = join(tmp, "not-a-root");
    mkdirSync(other);
    const log: string[] = [];
    sweep(tmp, remove, (m: string) => log.push(m));
    expect(existsSync(young)).toBe(true);
    expect(existsSync(dead)).toBe(false);
    sweep(tmp, remove, (m: string) => log.push(m), Date.now() + ROOT_GRACE_MS + 1000);
    expect(existsSync(young)).toBe(false);
    expect(existsSync(other)).toBe(true);
    expect(log).toHaveLength(2);
  });

  it("--auth-check sweeps only inside the post-confirmation step that creates the roots", () => {
    const src = readFileSync(RUN, "utf8");
    const body = src.slice(src.indexOf("async function runAuthCheck("));
    const makeRoots = body.indexOf("const makeRoots = () => {");
    expect(makeRoots).toBeGreaterThan(-1);
    expect(body.indexOf("sweep(TMP_ROOT")).toBeGreaterThan(makeRoots);
    expect(body).toContain("beforePrepare: makeRoots");
  });
});

describe("host-run pane token hand-over", () => {
  const files = new Set<string>();
  const fakeFs = {
    writeFile: (p: string) => files.add(p),
    exists: (p: string) => files.has(p),
    remove: (p: string) => files.delete(p),
  };
  const plan = {
    host: "claude-code",
    workspace: "/r/workspace",
    secret: { var: "CLAUDE_CODE_OAUTH_TOKEN", path: "/r/secrets/claude-code.env" },
    pane: { command: "env -i … /r/bin/launch-claude" },
  };

  it("keeps polling past 10 s while the wrapper has not started, without blocking", async () => {
    files.clear();
    let slept = 0;
    const sleep = async (ms: number) => {
      slept += ms;
      // The wrapper starts only after 25 s.
      if (slept >= 25_000) files.delete(plan.secret.path);
    };
    const herdr = { openPane: vi.fn(() => ({ workspace: "w1", pane: "p1" })) };
    const r = await openPaneWithToken(fakeFs, herdr, plan, "sk-ant-oat01-TEST-fake", {
      pickup: { sleep },
    });
    expect(r.notice).toBeNull();
    expect(slept).toBeGreaterThanOrEqual(25_000);
    expect(files.size).toBe(0);
  });

  it("on the bound, removes the file and says the host may start unauthenticated", async () => {
    files.clear();
    files.add(plan.secret.path);
    const notice = await awaitTokenPickup(fakeFs, plan.secret.path, {
      boundMs: 1000,
      stepMs: 100,
      sleep: async () => {},
    });
    expect(notice).toBe(
      "the pane had not started its wrapper after 1 s; token file removed, the host may start unauthenticated",
    );
    expect(files.size).toBe(0);
  });

  it("removes the token file when openPane throws", async () => {
    files.clear();
    const herdr = {
      openPane: vi.fn(() => {
        expect(files.has(plan.secret.path)).toBe(true);
        throw new Error("herdr down");
      }),
    };
    await expect(openPaneWithToken(fakeFs, herdr, plan, "sk-ant-oat01-TEST-fake")).rejects.toThrow(
      "herdr down",
    );
    expect(files.size).toBe(0);
  });
});

describe("host-run token redaction across wraps and pieces", () => {
  const TOKEN = "sk-ant-oat01-TESTabcdEFGH1234ijklMNOP5678qrstUVWX9012yzAB";

  it("redacts a token a pane wrapped over lines, indentation included, and keeps the rest", () => {
    const screen = `│ auth: ${TOKEN.slice(0, 30)}\n│       ${TOKEN.slice(30)} done\nnext line`;
    // The two halves sit behind a box border here: each half alone is caught.
    const boxed = redactSecrets(screen, [TOKEN]);
    expect(boxed).not.toContain(TOKEN.slice(20, 30));
    expect(boxed).not.toContain(TOKEN.slice(30, 42));
    const wrapped = `auth: ${TOKEN.slice(0, 25)}\n    ${TOKEN.slice(25)}\nnext line`;
    const out = redactSecrets(wrapped, [TOKEN]);
    expect(out).toBe("auth: [redacted]\nnext line");
    expect(containsSecret(wrapped, [TOKEN])).toBe(true);
  });

  it("catches any 12-character piece of the distinctive body, and nothing shorter", () => {
    const middle = TOKEN.slice(30, 42);
    expect(containsSecret(`saw ${middle} here`, [TOKEN])).toBe(true);
    expect(privacyViolations({ fragment: `x ${middle}` }, { secrets: [TOKEN] })).toContain(
      "contains a token",
    );
    expect(redactSecrets(`saw ${middle} here`, [TOKEN])).toBe("saw [redacted] here");
    expect(containsSecret(`saw ${TOKEN.slice(30, 41)} here`, [TOKEN])).toBe(false);
    // The public prefix alone, or with a short tail, identifies nobody.
    expect(containsSecret("sk-ant-oat01-TESTab", [TOKEN])).toBe(false);
  });
});
