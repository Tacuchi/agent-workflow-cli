// Probes and setup steps of the host run (plan 085, F3 support, s280 incident):
// a host's own output — an OAuth code agy echoed through /dev/tty, a refresh
// token, a key — never reaches the terminal, a log line or the evidence. Every
// host-side command runs with stdin ignored, its output captured and no
// controlling terminal; a failed probe is reported with ONE reason from a fixed
// vocabulary. Also: kimi is excluded, crush takes a provider key.
//
// Every secret here is synthetic, and assembled from pieces so no literal in
// this file has a credential's shape.

import { spawn, spawnSync } from "node:child_process";
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
import { AUTH_CHECK_WORD, IN_PANE, authCheck } from "../../scripts/host-run/authcheck.mjs";
import { classify, isPermissionScreen, readyForInput } from "../../scripts/host-run/classifier.mjs";
import {
  SECRET_PATTERNS,
  containsSecret,
  privacyViolations,
  redactSecrets,
} from "../../scripts/host-run/extract.mjs";
import { HerdrClient, herdrArgv, leftoverWorkspaces } from "../../scripts/host-run/herdr.mjs";
import { COVERED_HOSTS, HOSTS, NOT_COVERED, tokenSpec } from "../../scripts/host-run/hosts.mjs";
import {
  CAPTURED_SPAWN,
  MAX_TYPED_LAUNCH,
  agyErrorReason,
  capturedRun,
  capturedRunSync,
  keptMessage,
  nodeFs,
  nodeProcs,
  planIsolation,
  prepareHost,
  probeReason,
  reapRootProcesses,
  rootProcesses,
  rootTemplate,
} from "../../scripts/host-run/isolation.mjs";
import { renderLedger } from "../../scripts/host-run/ledger.mjs";
import { crushFields, prepareAll } from "../../scripts/host-run/live.mjs";
import { buildMatrix, catalogStates } from "../../scripts/host-run/matrix.mjs";
import { PROFILES } from "../../scripts/host-run/profiles/index.mjs";
import { buildScenario } from "../../scripts/host-run/scenario.mjs";
import { capabilitiesFor } from "../../src/application/self/host-states.js";
import { HARNESSES } from "../../src/domain/harnesses.js";

const fake = (...parts: string[]) => parts.join("");
const OAUTH_CODE = fake("4/", "0A", "TEST_not_a_real_code_0000000000");
const REFRESH = fake("1//", "0", "TEST-not-a-real-refresh-token-0000");
const ANTHROPIC = fake("sk-", "ant-oat01-", "TEST-not-a-real-token-0000000000000000");
const GEMINI_PREFIX = fake("AI", "za");
const GEMINI_KEY = fake(GEMINI_PREFIX, "TEST-not-a-real-gemini-key-0000000000");
const OTHER_GEMINI_KEY = fake(GEMINI_PREFIX, "TEST-another-fake-key-for-crush-0000");
const OPENAI_KEY = fake("s", "k-proj-", "TEST-not-a-real-openai-key");
const RUN = join(__dirname, "..", "..", "scripts", "host-run", "run.mjs");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "host-run-probe-")));
  dirs.push(d);
  return d;
};

/**
 * A host that behaves like agy without a login: prints the secrets to stdout and
 * stderr, tries to write to /dev/tty (records whether it could), and says it
 * cannot complete an interactive login.
 */
function fakeHost(dir: string) {
  const bin = join(dir, "fake-host");
  const marker = join(dir, "tty-opened");
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      `echo "Enter the authorization code: ${OAUTH_CODE}"`,
      `echo "refresh ${REFRESH} key ${ANTHROPIC}" >&2`,
      `if (: > /dev/tty) 2>/dev/null; then echo "${OAUTH_CODE}" > /dev/tty; : > '${marker}'; fi`,
      'echo "Print mode: not logged in and no controlling terminal; cannot complete interactive login" >&2',
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
  return { bin, marker };
}

/** opencode's real plan in a temp root, reduced to its auth probe pointed at the fake host. */
function probeOnlyPlan(root: string, bin: string) {
  const plan = planIsolation({
    hostId: "opencode",
    root,
    checkout: "/checkout",
    node: process.execPath,
    hostBin: bin,
    realHome: join(root, "no-real-home"),
    profile: PROFILES.opencode,
  });
  const probe = plan.steps.find((s: { kind: string }) => s.kind === "auth-probe");
  return { ...plan, steps: [{ ...probe, bin }] };
}

const leaks = (text: string) =>
  [OAUTH_CODE, REFRESH, ANTHROPIC, fake("4/", "0A"), fake("1//", "0"), fake("sk-", "ant-")].filter(
    (s) => text.includes(s),
  );

describe("host-run probes never reach the terminal", () => {
  it("every host-side command: stdin ignored, output captured, a new session (no controlling terminal)", () => {
    expect(CAPTURED_SPAWN.stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(CAPTURED_SPAWN.detached).toBe(true);
    const calls: unknown[][] = [];
    const sync = capturedRunSync((...a: unknown[]) => {
      calls.push(a);
      return { status: 0, stdout: "", stderr: "", pid: 0 };
    });
    sync("x", ["y"], { env: { A: "1" }, cwd: "/w", timeout: 5 });
    expect(calls[0][2]).toMatchObject({
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      timeout: 5,
    });
    const spawned: unknown[][] = [];
    capturedRun((...a: unknown[]) => {
      spawned.push(a);
      throw new Error("not spawned in this test");
    })("x", ["y"], { env: { A: "1" }, cwd: "/w" });
    expect(spawned[0][2]).toMatchObject({ stdio: ["ignore", "pipe", "pipe"], detached: true });
    // run.mjs routes setup steps, probes and version reads through it, and never inherits.
    const src = readFileSync(RUN, "utf8");
    expect(src).toContain("const hostRun = capturedRun(spawn)");
    expect(src).toContain("const hostRead = capturedRunSync(spawnSync)");
    expect(src).not.toMatch(/stdio:\s*["']inherit["']/);
    expect(src.match(/run: hostRun/g)?.length).toBe(2);
  });

  it("--auth-check path: a probe printing an OAuth code, a refresh token and a key leaks none of them", async () => {
    const dir = temp();
    const { bin, marker } = fakeHost(dir);
    const plan = probeOnlyPlan(join(dir, "root"), bin);
    const logs: string[] = [];
    const code = await authCheck({
      stdinIsTTY: true,
      stdoutIsTTY: true,
      env: {},
      markers: [],
      ancestor: () => null,
      hosts: ["opencode"],
      tokens: {},
      ask: async () => AUTH_CHECK_WORD,
      log: (m: string) => logs.push(m),
      prepare: () => prepareHost(plan, { fs: nodeFs(), run: capturedRun(spawn), secrets: {} }),
      finish: () => {},
    });
    expect(code).toBe(1);
    const out = logs.join("\n");
    expect(leaks(out)).toEqual([]);
    expect(containsSecret(out, [])).toBe(false);
    expect(out).toMatch(/opencode\s+NOT authenticated \(probe needs interactive sign-in\)/);
    // No controlling terminal: /dev/tty could not even be opened.
    expect(existsSync(marker)).toBe(false);
  });

  it("pre-run path: the live preparation logs only fixed reasons", async () => {
    const dir = temp();
    const { bin, marker } = fakeHost(dir);
    const logs: string[] = [];
    const plans = await prepareAll({
      hosts: ["opencode"],
      makeRoot: () => join(dir, "root"),
      cleanup: { track: () => {} },
      planFor: (_id: string, root: string) => probeOnlyPlan(root, bin),
      prepareDeps: { fs: nodeFs(), run: capturedRun(spawn), secrets: {} },
      log: (m: string) => logs.push(m),
    });
    expect(plans).toBeNull();
    const out = logs.join("\n");
    expect(leaks(out)).toEqual([]);
    expect(out).toContain("NOT authenticated: probe needs interactive sign-in");
    expect(existsSync(marker)).toBe(false);
  });

  it.runIf(process.platform === "darwin" && existsSync("/usr/bin/script"))(
    "under a real terminal (a pty), the probe still cannot open /dev/tty",
    () => {
      const dir = temp();
      const { bin, marker } = fakeHost(dir);
      const driver = join(dir, "driver.mjs");
      const isolation = join(__dirname, "..", "..", "scripts", "host-run", "isolation.mjs");
      writeFileSync(
        driver,
        [
          'import { spawn } from "node:child_process";',
          `import { capturedRun } from ${JSON.stringify(isolation)};`,
          `const r = await capturedRun(spawn)(${JSON.stringify(bin)}, [], { env: { PATH: "/usr/bin:/bin" }, cwd: ${JSON.stringify(dir)} });`,
          'process.stdout.write("status=" + r.status + "\\n");',
          "",
        ].join("\n"),
      );
      const r = spawnSync("/usr/bin/script", ["-q", "/dev/null", process.execPath, driver], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
      });
      expect(r.stdout).toContain("status=1");
      // What the person would have seen on their terminal: nothing of the fake host.
      expect(leaks(r.stdout)).toEqual([]);
      expect(existsSync(marker)).toBe(false);
    },
  );

  it("a failed probe gets ONE reason from a fixed vocabulary; its text only classifies", () => {
    expect(probeReason({ status: null, error: { code: "ETIMEDOUT" } })).toBe("timeout");
    expect(probeReason({ status: null, signal: "SIGKILL" })).toBe("timeout");
    expect(probeReason({ status: null, error: { code: "ENOENT" } })).toBe("probe binary not found");
    expect(
      probeReason({
        status: 1,
        stdout: "",
        stderr: `Please visit the URL to log in: ${OAUTH_CODE}`,
      }),
    ).toBe("probe needs interactive sign-in");
    expect(probeReason({ status: 1, stdout: "HTTP 401 Unauthorized", stderr: "" })).toBe(
      "credentials rejected",
    );
    expect(probeReason({ status: 1, stdout: "No providers configured", stderr: "" })).toBe(
      "no provider or model configured",
    );
    expect(probeReason({ status: 3, stdout: `x ${ANTHROPIC}`, stderr: "" })).toBe("probe exited 3");
  });

  it("a probe that waits for a sign-in times out and says only that", async () => {
    const dir = temp();
    const bin = join(dir, "waits");
    writeFileSync(bin, `#!/bin/sh\necho "${OAUTH_CODE}"\nsleep 5\n`);
    chmodSync(bin, 0o755);
    const plan = probeOnlyPlan(join(dir, "root"), bin);
    plan.steps[0].timeoutMs = 300;
    const log = await prepareHost(plan, { fs: nodeFs(), run: capturedRun(spawn), secrets: {} });
    expect(log.at(-1)).toMatchObject({ ok: false, reason: "timeout" });
    expect(JSON.stringify(log)).not.toContain(OAUTH_CODE);
  });

  it("an absent required token (claude) is said up front and no probe is spent", async () => {
    const logs: string[] = [];
    const prepare = vi.fn(() => []);
    await authCheck({
      stdinIsTTY: true,
      stdoutIsTTY: true,
      env: {},
      markers: [],
      ancestor: () => null,
      hosts: ["claude-code"],
      tokens: { "claude-code": { label: "claude token", state: "absent" } },
      ask: async () => AUTH_CHECK_WORD,
      log: (m: string) => logs.push(m),
      prepare,
      finish: () => {},
    });
    expect(prepare).not.toHaveBeenCalled();
    const line =
      "token absent (CLAUDE_CODE_OAUTH_TOKEN not set in this shell; export it in the same terminal or use --claude-token-file)";
    const outcomeAt = logs.findIndex(
      (l) => l.includes("claude-code") && l.includes("NOT authenticated"),
    );
    const announcedAt = logs.findIndex((l) => l.includes(line));
    expect(announcedAt).toBeGreaterThan(-1);
    expect(announcedAt).toBeLessThan(outcomeAt);
    expect(logs[outcomeAt]).toContain(`NOT authenticated (${line})`);
  });
});

describe("host-run redaction of credential shapes", () => {
  it("redacts Google OAuth codes, refresh and access tokens, and the generic families", () => {
    const samples = [
      OAUTH_CODE,
      REFRESH,
      fake("ya", "29.", "TEST-not-a-real-access-token"),
      fake("gh", "p_", "TESTnotarealgithubtoken0000"),
      ANTHROPIC,
      OPENAI_KEY,
      GEMINI_KEY,
      fake("xo", "xb-", "TEST-not-a-real-slack"),
      fake("ey", "JhbGciOiJIUzI1.", "eyJzdWIiOiJ0ZXN0.", "TESTsignature00"),
    ];
    for (const s of samples) {
      const text = `before ${s} after`;
      expect(containsSecret(text, []), s).toBe(true);
      expect(redactSecrets(text, []), s).toBe("before [redacted] after");
      expect(privacyViolations({ fragment: text }, {}), s).toContain("contains a token");
    }
    expect(SECRET_PATTERNS.length).toBeGreaterThanOrEqual(9);
  });

  it("leaves ordinary text alone: dates, paths, words with sk-", () => {
    for (const text of [
      "on 2026/4/0 the run and 4/0 of the checks",
      "GET /api/v4/0Abcdefghijklmnop",
      "path a/4/0Abcdefghijkl and x.1//0abcdefghijklmn",
      "task-abcdefghijklmnopqrstuvwxyz and disk-usage-over-the-limit-now",
      "echo sk-ant-oat01-hello",
      fake(GEMINI_PREFIX, "Short"),
      "eyJ.not.jwt",
    ]) {
      expect(containsSecret(text, []), text).toBe(false);
      expect(redactSecrets(text, []), text).toBe(text);
    }
  });
});

describe("host-run coverage: kimi excluded by the person", () => {
  it("kimi is not covered with its reason, and a matrix records it", () => {
    expect(NOT_COVERED.kimi).toMatch(/subscription cancelled by the person/);
    const m = buildMatrix({
      runId: "r1",
      date: "2026-09-29",
      cli: { version: "28.0.0", revision: "0000000" },
      scenarioDigest: "d",
      catalog: catalogStates(HARNESSES, capabilitiesFor),
      hostRuns: {},
    });
    expect(m.hosts.kimi).toMatchObject({ covered: false, reason: NOT_COVERED.kimi });
    // The profile stays, out of every run.
    expect(PROFILES.kimi).toBeDefined();
  });
});

describe("host-run crush provider key", () => {
  const gemini = HOSTS.crush.tokenChoices[0];
  const openai = HOSTS.crush.tokenChoices[1];
  const crushPlan = (over: Record<string, unknown> = {}) =>
    planIsolation({
      hostId: "crush",
      root: "/tmp/fake/aw-host-run-r1-crush-AbC",
      checkout: "/checkout",
      node: "/usr/local/bin/node",
      hostBin: "/opt/crush",
      realHome: "/Users/someone",
      profile: PROFILES.crush,
      ...over,
    });
  const crushConfig = (plan: {
    steps: { kind: string; files?: { path: string; value: unknown }[] }[];
  }) =>
    plan.steps
      .find((s) => s.kind === "profile")
      ?.files?.find((f) => f.path === ".config/crush/crush.json")?.value as Record<string, never>;

  it("Gemini first: with both keys crush takes Gemini; with one, that one", () => {
    expect(tokenSpec("crush", () => true)).toBe(gemini);
    expect(tokenSpec("crush", (s: { env: string }) => s.env === "OPENAI_API_KEY")).toBe(openai);
    expect(tokenSpec("crush", () => false)).toBe(gemini);
    expect(gemini).toMatchObject({ provider: "gemini", model: "gemini-3-flash-preview" });
  });

  it("with a key: provider and model in crush.json as $VAR, no own data copied, model on the probe, key only in the wrapper", () => {
    const plan = crushPlan({ tokenPresent: true, token: gemini });
    const config = crushConfig(plan);
    expect(config.providers).toEqual({ gemini: { api_key: "$GEMINI_API_KEY" } });
    expect(config.models).toEqual({
      large: { provider: "gemini", model: "gemini-3-flash-preview" },
      small: { provider: "gemini", model: "gemini-3-flash-preview" },
    });
    expect(plan.steps.find((s: { kind: string }) => s.kind === "credentials").copies).toEqual([]);
    const probe = plan.steps.find((s: { kind: string }) => s.kind === "auth-probe");
    expect(probe.args.slice(0, 3)).toEqual(["run", "-m", "gemini/gemini-3-flash-preview"]);
    expect(probe.bin).toBe(`${plan.root}/bin/launch-crush`);
    expect(plan.secret).toMatchObject({ host: "crush", var: "GEMINI_API_KEY" });
    // Without a key: the person's own crush data, no provider block.
    const own = crushPlan();
    expect(crushConfig(own)).not.toHaveProperty("models");
    expect(own.steps.find((s: { kind: string }) => s.kind === "credentials").copies).toHaveLength(
      1,
    );
  });

  it("the matrix and the ledger's run block record crush's provider and model", () => {
    expect(crushFields({ provider: "gemini", model: "gemini-3-flash-preview" })).toEqual({
      crush_provider: "gemini",
      crush_model: "gemini-3-flash-preview",
    });
    expect(crushFields("own-data")).toEqual({ crush_provider: "own-data", crush_model: null });
    const m = buildMatrix({
      runId: "r1",
      date: "2026-09-29",
      cli: { version: "28.0.0", revision: "0000000" },
      scenarioDigest: "d",
      catalog: catalogStates(HARNESSES, capabilitiesFor),
      hosts: ["crush"],
      hostRuns: {
        crush: { version: "0.96.1", ...crushFields({ provider: "gemini", model: "m" }), cells: {} },
      },
    });
    expect(m.hosts.crush).toMatchObject({ crush_provider: "gemini", crush_model: "m" });
    const text = renderLedger([
      [
        "crush",
        {
          version: "0.96.1",
          at: "2026-09-29",
          depth: "install",
          run: {
            id: "r1",
            at: "2026-09-29",
            version: "0.96.1",
            cli: { version: "28.0.0", revision: "0000000" },
            cells: {},
            crush_provider: "gemini",
            crush_model: "m",
          },
        },
      ],
    ]);
    expect(text).toContain('crush_provider: "gemini"');
    expect(text).toContain('crush_model: "m"');
  });

  it("the dry-run names crush's provider and model and its key's presence, never a value; agy never gets the key", () => {
    const dir = temp();
    const crushFile = join(dir, "crush");
    writeFileSync(crushFile, `${OTHER_GEMINI_KEY}\n`, { mode: 0o600 });
    const env: Record<string, string | undefined> = { ...process.env };
    for (const v of [
      "CLAUDE_CODE_OAUTH_TOKEN",
      "GEMINI_API_KEY",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "GOOGLE_API_KEY",
    ])
      delete env[v];
    const dry = (extra: string[], more: Record<string, string> = {}) =>
      spawnSync(process.execPath, [RUN, "--dry-run", "--hosts", "gemini,crush", ...extra], {
        encoding: "utf8",
        env: { ...env, ...more },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 120_000,
      });
    const r = dry(["--crush-gemini-key-file", crushFile]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("crush Gemini API key: present (from --crush-gemini-key-file");
    expect(r.stdout).toContain("crush → gemini/gemini-3-flash-preview");
    expect(r.stdout).toContain("agy → sign-in in the pane (you sign in when the run starts)");
    expect(r.stdout).not.toContain(fake(GEMINI_PREFIX, "TEST"));
    // Only crush has a wrapper and a token file; agy has none.
    expect(r.stdout).toMatch(/crush-X+\/secrets\/crush\.env/);
    expect(r.stdout).not.toMatch(/secrets\/gemini\.env|launch-agy/);
    // A GEMINI_API_KEY in the shell feeds crush, never agy; with both keys, Gemini is used.
    const both = dry([], { GEMINI_API_KEY: GEMINI_KEY, OPENAI_API_KEY: OPENAI_KEY });
    expect(both.status, both.stderr).toBe(0);
    expect(both.stdout).toContain("both keys given: Gemini (free) is used");
    expect(both.stdout).toContain("go to crush only, never to agy");
    expect(both.stdout).not.toContain(OPENAI_KEY);
    expect(both.stdout).not.toContain(fake(GEMINI_PREFIX, "TEST"));
  }, 240_000);
});

describe("host-run: a failed probe explains itself; agy signs in inside its pane", () => {
  /** A fake host that fails the way agy 1.2.x does on a model API error: exit 3 and an AGY_ERROR line. */
  function fakeExit3(dir: string) {
    const bin = join(dir, "fake-agy");
    const error = JSON.stringify({
      short_error: `request with key ${GEMINI_KEY} failed`,
      status: "RESOURCE_EXHAUSTED",
      message: "CONFIDENTIAL_PROJECT_NAME",
      http_status: 429,
      retryable: false,
      error_id: "TEST-id",
    });
    writeFileSync(
      bin,
      `#!/bin/sh\necho 'partial answer'\necho 'AGY_ERROR: ${error}' >&2\nexit 3\n`,
    );
    chmodSync(bin, 0o755);
    return bin;
  }

  it("exit 3 with AGY_ERROR: one sanitized reason, and the output kept redacted in a 0600 file of a 0700 dir", async () => {
    const dir = temp();
    const bin = fakeExit3(dir);
    const plan = probeOnlyPlan(join(dir, "root"), bin);
    const kept = join(dir, "transcripts");
    mkdirSync(kept, { mode: 0o700 });
    const keepProbeOutput = (host: string, text: string) => {
      const path = join(kept, `probe-${host}.log`);
      writeFileSync(path, text, { mode: 0o600 });
      return path;
    };
    const logs: string[] = [];
    await authCheck({
      stdinIsTTY: true,
      stdoutIsTTY: true,
      env: {},
      markers: [],
      ancestor: () => null,
      hosts: ["opencode"],
      tokens: {},
      ask: async () => AUTH_CHECK_WORD,
      log: (m: string) => logs.push(m),
      prepare: () =>
        prepareHost(plan, {
          fs: nodeFs(),
          run: capturedRun(spawn),
          secrets: { opencode: GEMINI_KEY },
          keepProbeOutput,
        }),
      finish: () => {},
    });
    const out = logs.join("\n");
    const path = join(kept, "probe-opencode.log");
    expect(out).toContain(
      `NOT authenticated (model API error: RESOURCE_EXHAUSTED, http_status 429, not retryable) — probe output (redacted): ${path}`,
    );
    expect(out).not.toContain(GEMINI_KEY);
    expect(out).not.toContain("request with key");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(kept).mode & 0o777).toBe(0o700);
    const text = readFileSync(path, "utf8");
    expect(text).toContain("RESOURCE_EXHAUSTED");
    expect(text).toContain("[redacted]");
    expect(text).not.toContain(GEMINI_KEY);
  });

  it("the AGY_ERROR line gives only enum-shaped statuses and numeric codes, never its free text", () => {
    expect(agyErrorReason("nothing here")).toBeNull();
    // Any other all-caps leaf is never read out.
    expect(
      agyErrorReason(
        'AGY_ERROR: {"message":"CONFIDENTIAL_PROJECT_NAME","canonical_status":"SECRET_THING","error":{"reason":"QUOTA_EXCEEDED","detail":"PRIVATE_REPO"}}',
      ),
    ).toBe("model API error: QUOTA_EXCEEDED");
    expect(agyErrorReason('AGY_ERROR: {"short_error":"model gemini-x not found for you"}')).toBe(
      "model API error",
    );
    expect(
      agyErrorReason('AGY_ERROR: {"status":"NOT_FOUND","code":404,"message":"Model X is gone"}'),
    ).toBe("model API error: NOT_FOUND, code 404");
    expect(agyErrorReason("AGY_ERROR: {broken}")).toBe(
      "model API error (unreadable AGY_ERROR line)",
    );
    expect(
      probeReason({ status: 3, stdout: "", stderr: 'AGY_ERROR: {"status":"PERMISSION_DENIED"}' }),
    ).toBe("model API error: PERMISSION_DENIED");
  });

  it("agy: no auth probe in its plan, the auth check reports it signing in in the pane, never a failure", async () => {
    const agy = planIsolation({
      hostId: "gemini",
      root: "/tmp/fake/aw-host-run-r1-gemini-AbC",
      checkout: "/checkout",
      node: "/usr/local/bin/node",
      hostBin: "/opt/agy",
      realHome: "/Users/someone",
      profile: PROFILES.gemini,
      tokenPresent: true,
    });
    expect(agy.signInInPane).toBe(true);
    expect(agy.steps.some((s: { kind: string }) => s.kind === "auth-probe")).toBe(false);
    expect(agy.secret).toBeNull();
    const logs: string[] = [];
    const prepare = vi.fn(() => []);
    const code = await authCheck({
      stdinIsTTY: true,
      stdoutIsTTY: true,
      env: {},
      markers: [],
      ancestor: () => null,
      hosts: ["gemini"],
      inPane: ["gemini"],
      tokens: {},
      ask: async () => AUTH_CHECK_WORD,
      log: (m: string) => logs.push(m),
      prepare,
      finish: () => {},
    });
    expect(code).toBe(0);
    expect(prepare).not.toHaveBeenCalled();
    expect(IN_PANE).toBe("sign-in in the pane (you sign in when the run starts)");
    expect(logs.join("\n")).toContain(`gemini       ${IN_PANE}`);
    // run.mjs hands every signInInPane host to the auth check that way, and the digest seals it.
    const src = readFileSync(RUN, "utf8");
    expect(src).toContain("inPane: args.hosts.filter((id) => HOSTS[id].signInInPane)");
    expect(src).toContain(
      '...(plan.signInInPane ? { sign_in: "sign-in in the pane, real keychain accepted" } : {})',
    );
  });

  it("agy's OAuth screen in the pane is permission-class: no keystrokes; its code and URL are redacted", () => {
    const url = fake(
      "https://accounts.google.com/o/oauth2/auth?client_id=TEST",
      "&redirect_uri=http%3A%2F%2F127.0.0.1&state=TESTstate&code_challenge=TESTchallenge",
    );
    for (const screen of [
      [
        "Authentication required. Please visit the URL to log in:",
        url,
        "Waiting for authentication (timeout 60s)...",
      ].join("\n"),
      [
        "Select login method:",
        "Opening browser to authenticate with Google...",
        "If you aren't automatically redirected, paste the authorization code below:",
        `> ${OAUTH_CODE}`,
      ].join("\n"),
      "Sign in with your Google account to continue",
    ]) {
      const pane = { host: "gemini", state: "idle", screen };
      expect(classify(pane, null).action, screen).toBe("notify");
      expect(readyForInput(pane).ok, screen).toBe(false);
      const redacted = redactSecrets(screen, []);
      expect(redacted).not.toContain(OAUTH_CODE);
      expect(redacted).not.toContain("TESTstate");
    }
    const withCode = `code ${OAUTH_CODE} at ${url}`;
    expect(privacyViolations({ fragment: withCode }, {})).toContain("contains a token");
  });

  it("the dry-run says agy signs in in its pane and runs no agy probe", () => {
    const env: Record<string, string | undefined> = { ...process.env };
    for (const v of ["GEMINI_API_KEY", "GOOGLE_API_KEY"]) delete env[v];
    const r = spawnSync(process.execPath, [RUN, "--dry-run", "--hosts", "gemini"], {
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("agy → sign-in in the pane (you sign in when the run starts)");
    expect(r.stdout).not.toMatch(/auth probe: /);
    expect(r.stdout).toMatch(/Approval digest: \w+/);
  }, 240_000);
});

describe("host-run process groups, detached servers and signals", () => {
  const isolation = join(__dirname, "..", "..", "scripts", "host-run", "isolation.mjs");
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const waitFor = async (cond: () => boolean, ms = 5000) => {
    const end = Date.now() + ms;
    while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    return cond();
  };

  it("crush runs in-process with a fixed catalog; its key's inheritance is declared", () => {
    expect(HOSTS.crush.childEnv).toEqual({
      CRUSH_CLIENT_SERVER: "0",
      CRUSH_DISABLE_PROVIDER_AUTO_UPDATE: "1",
    });
    const p = planIsolation({
      hostId: "crush",
      root: "/tmp/fake/aw-host-run-r1-crush-AbC",
      checkout: "/checkout",
      node: "/usr/local/bin/node",
      hostBin: "/opt/crush",
      realHome: "/Users/someone",
      profile: PROFILES.crush,
    });
    expect(p.pane.launchLine).toContain("CRUSH_CLIENT_SERVER=0");
    expect(p.pane.launchLine).toContain("CRUSH_DISABLE_PROVIDER_AUTO_UPDATE=1");
    expect(PROFILES.crush.limitations.join(" ")).toMatch(/children .* inherit it/);
  });

  it("after a step, its whole process group goes: a grandchild sleep does not outlive it", async () => {
    const dir = temp();
    const bin = join(dir, "forks");
    const pidFile = join(dir, "grandchild");
    writeFileSync(bin, `#!/bin/sh\nsleep 30 &\necho $! > '${pidFile}'\nexit 0\n`);
    chmodSync(bin, 0o755);
    const r = await capturedRun(spawn)(bin, [], { env: { PATH: "/usr/bin:/bin" }, cwd: dir });
    expect(r.status).toBe(0);
    const grandchild = Number(readFileSync(pidFile, "utf8"));
    expect(await waitFor(() => !alive(grandchild))).toBe(true);
  });

  it("on a timeout the whole group is killed, not only the direct child", async () => {
    const dir = temp();
    const bin = join(dir, "hangs");
    const pidFile = join(dir, "grandchild");
    writeFileSync(bin, `#!/bin/sh\nsleep 30 &\necho $! > '${pidFile}'\nwait\n`);
    chmodSync(bin, 0o755);
    const started = Date.now();
    const r = await capturedRun(spawn)(bin, [], {
      env: { PATH: "/usr/bin:/bin" },
      cwd: dir,
      timeout: 300,
    });
    expect(r.error).toEqual({ code: "ETIMEDOUT" });
    expect(Date.now() - started).toBeLessThan(5000);
    const grandchild = Number(readFileSync(pidFile, "utf8"));
    expect(await waitFor(() => !alive(grandchild))).toBe(true);
  });

  it("cleanup ends a daemon that left the group (its own session) when it runs from a root", async () => {
    const dir = temp();
    const root = join(dir, "aw-host-run-r1-crush-X");
    mkdirSync(join(root, "bin"), { recursive: true });
    // A server script inside the root: its command line names the root.
    const daemonBin = join(root, "bin", "fake-server");
    writeFileSync(daemonBin, "#!/bin/sh\nwhile :; do sleep 1; done\n");
    chmodSync(daemonBin, 0o755);
    const pidFile = join(dir, "daemon");
    // Daemonizes: forks, the child starts a new session, execs the server.
    const bin = join(dir, "daemonizes");
    writeFileSync(
      bin,
      `#!/bin/sh\n/usr/bin/perl -e 'use POSIX; my $p = fork; if ($p) { select(undef, undef, undef, 0.05) until -e "${pidFile}"; exit 0 } POSIX::setsid(); open(my $f, ">", "${pidFile}.tmp"); print $f $$; close $f; rename "${pidFile}.tmp", "${pidFile}"; open STDIN, "<", "/dev/null"; open STDOUT, ">", "/dev/null"; open STDERR, ">", "/dev/null"; exec "${daemonBin}", "60"'\n`,
    );
    chmodSync(bin, 0o755);
    await capturedRun(spawn)(bin, [], { env: { PATH: "/usr/bin:/bin" }, cwd: dir });
    expect(await waitFor(() => existsSync(pidFile))).toBe(true);
    const daemon = Number(readFileSync(pidFile, "utf8"));
    // It escaped the step's group (its own session): only the root reaping finds it.
    expect(alive(daemon)).toBe(true);
    const reaped = reapRootProcesses([root]);
    expect(reaped.killed).toContain(daemon);
    expect(await waitFor(() => !alive(daemon))).toBe(true);
  });

  it("finds a root's processes by command line or working directory; spares itself and any terminal", () => {
    const ps = [
      "  101   101   101 ??       /tmp/r/aw-host-run-x/bin/fake-server 60",
      "  102   102   102 ??       /opt/crush server",
      "  103   103   103 ??       /usr/bin/other /tmp/r/aw-host-run-xy/file",
      "  104   104   104 ttys003  -zsh",
      `  ${process.pid}   77   1 ??       node /tmp/r/aw-host-run-x/run`,
    ].join("\n");
    const cwds = { 102: "/tmp/r/aw-host-run-x/workspace", 104: "/tmp/r/aw-host-run-x" };
    expect(rootProcesses(ps, cwds, ["/tmp/r/aw-host-run-x"])).toEqual({
      kill: [
        { pid: 101, pgid: 101 },
        { pid: 102, pgid: 102 },
      ],
      kept: [{ pid: 104, pgid: 104, name: "-zsh" }],
      ownPgid: 77,
    });
  });

  it("the reap kills each matched group, never its own, a terminal's, 0 or 1; a terminal is reported", () => {
    const ps = [
      "  201   201   201 ??       /tmp/r/aw-host-run-x/bin/srv",
      "  202    77    77 ??       /tmp/r/aw-host-run-x/bin/helper",
      "  203     1     1 ??       /tmp/r/aw-host-run-x/bin/odd",
      "  204   204   204 ttys001  /bin/zsh",
      "  205   204   204 ttys001  /tmp/r/aw-host-run-x/bin/tool",
      `  ${process.pid}   77   77 ??       node run.mjs`,
    ].join("\n");
    const kills: [number, string][] = [];
    const r = reapRootProcesses(["/tmp/r/aw-host-run-x"], {
      ps: () => ps,
      cwds: () => ({ 204: "/tmp/r/aw-host-run-x/home" }),
      kill: (pid: number, sig: string) => kills.push([pid, sig]),
      alive: () => false,
      pause: () => {},
    });
    const groups = kills.filter(([pid]) => pid < 0).map(([pid]) => -pid);
    expect([...new Set(groups)]).toEqual([201]);
    expect(kills.some(([pid]) => pid === 204 || pid === 205)).toBe(false);
    expect(r.kept).toEqual([
      { pid: 204, name: "zsh" },
      { pid: 205, name: "tool" },
    ]);
    expect(keptMessage(r.kept)).toBe(
      "left running (they have a terminal, inside a disposable root): 204 zsh, 205 tool — leave that directory; the root is being removed",
    );
  });

  it("a matched sh's child in the same group dies with it", async () => {
    const dir = temp();
    const root = join(dir, "aw-host-run-r1-crush-G");
    mkdirSync(join(root, "bin"), { recursive: true });
    const srv = join(root, "bin", "srv.sh");
    const pidFile = join(dir, "child");
    // The child `sleep` names no root: only its group ties it to one.
    writeFileSync(srv, `#!/bin/sh\nsleep 60 &\necho $! > '${pidFile}'\nwait\n`);
    chmodSync(srv, 0o755);
    const leader = spawn("/bin/sh", [srv], { detached: true, stdio: "ignore", cwd: dir });
    expect(await waitFor(() => existsSync(pidFile))).toBe(true);
    const child = Number(readFileSync(pidFile, "utf8"));
    const r = reapRootProcesses([root]);
    expect(r.killed).toContain(leader.pid);
    expect(r.killed).not.toContain(child);
    expect(await waitFor(() => !alive(child))).toBe(true);
  });

  it.runIf(process.platform === "darwin" && existsSync("/usr/bin/script"))(
    "a process with a terminal inside a root is not killed, and is reported",
    async () => {
      const dir = temp();
      const root = join(dir, "aw-host-run-r1-codex-T");
      mkdirSync(root);
      const pidFile = join(dir, "tty-pid");
      // `script` gives it a pty: a stand-in for the person's shell cd-ed into the root.
      const holder = spawn(
        "/usr/bin/script",
        [
          "-q",
          "/dev/null",
          "/bin/sh",
          "-c",
          `cd '${root}' && echo $$ > '${pidFile}' && exec sleep 30`,
        ],
        { stdio: ["ignore", "ignore", "ignore"] },
      );
      try {
        expect(
          await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== ""),
        ).toBe(true);
        const pid = Number(readFileSync(pidFile, "utf8"));
        expect(
          await waitFor(() =>
            rootProcesses(nodeProcs().ps(), nodeProcs().cwds(), [root]).kept.some(
              (k) => k.pid === pid,
            ),
          ),
        ).toBe(true);
        const r = reapRootProcesses([root]);
        expect(r.kept.map((k) => k.pid)).toContain(pid);
        expect(r.killed).not.toContain(pid);
        await new Promise((res) => setTimeout(res, 300));
        expect(alive(pid)).toBe(true);
        process.kill(pid, "SIGKILL");
      } finally {
        holder.kill("SIGKILL");
      }
    },
    30_000,
  );

  it("SIGTERM during a long step kills its group within a second and cleanup removes the root", async () => {
    const dir = temp();
    const root = join(dir, "aw-host-run-r1-opencode-X");
    mkdirSync(root);
    const pidFile = join(dir, "grandchild");
    const step = join(dir, "long");
    writeFileSync(step, `#!/bin/sh\nsleep 60 &\necho $! > '${pidFile}'\nwait\n`);
    chmodSync(step, 0o755);
    const driver = join(dir, "driver.mjs");
    writeFileSync(
      driver,
      [
        'import { spawn } from "node:child_process";',
        'import { rmSync } from "node:fs";',
        `import { Cleanup, capturedRun, reapRootProcesses } from ${JSON.stringify(isolation)};`,
        "const cleanup = new Cleanup((p) => rmSync(p, { recursive: true, force: true }), undefined, (roots) => reapRootProcesses(roots));",
        `cleanup.track(${JSON.stringify(root)});`,
        "cleanup.install();",
        'process.stdout.write("ready\\n");',
        `await capturedRun(spawn)(${JSON.stringify(step)}, [], { env: { PATH: "/usr/bin:/bin" }, cwd: ${JSON.stringify(dir)}, timeout: 60000 });`,
        "",
      ].join("\n"),
    );
    const child = spawn(process.execPath, [driver], { stdio: ["ignore", "pipe", "pipe"] });
    expect(await waitFor(() => existsSync(pidFile))).toBe(true);
    const grandchild = Number(readFileSync(pidFile, "utf8"));
    const sent = Date.now();
    child.kill("SIGTERM");
    const exited = await new Promise<number>((r) => child.on("exit", () => r(Date.now())));
    expect(exited - sent).toBeLessThan(1500);
    expect(await waitFor(() => !alive(grandchild), 1500)).toBe(true);
    expect(existsSync(root)).toBe(false);
  }, 30_000);
});

describe("host-run: sign-in markers only on agy; kimi refused; the scenario never logs agy out", () => {
  it("a claude pane with «Sign in» text is not a permission screen; the same text on agy is", () => {
    const screen = "The settings page has a Sign in section.\n> ";
    expect(isPermissionScreen(screen, null, { host: "claude-code" })).toBe(false);
    expect(classify({ host: "claude-code", state: "idle", screen }, null).action).not.toBe(
      "notify",
    );
    expect(isPermissionScreen(screen, null, { host: "gemini" })).toBe(true);
  });

  it("--hosts kimi refuses with its reason", () => {
    const r = spawnSync(process.execPath, [RUN, "--dry-run", "--hosts", "kimi"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
    expect(r.status).toBe(2);
    expect(r.stderr.trim()).toBe(`kimi: not covered: ${NOT_COVERED.kimi}`);
  }, 240_000);

  it("nothing the scenario sends to agy is /logout or an auth command", () => {
    const scenario = buildScenario(["gemini"]);
    const sent = scenario.steps.flatMap(
      (st: { hosts: Record<string, { text: string }>; boundaries?: { answer: string }[] }) => [
        st.hosts.gemini?.text ?? "",
        ...(st.boundaries ?? []).map((b) => b.answer),
      ],
    );
    expect(sent.length).toBeGreaterThan(0);
    for (const text of sent)
      expect(text).not.toMatch(/\/?logout|\/?login|\bauth\b|sign[- ]?(in|out)/i);
  });

  it("the dry-run and the digest carry agy's keychain consent; the matrix records it", () => {
    const r = spawnSync(process.execPath, [RUN, "--dry-run", "--hosts", "gemini"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
    expect(r.stdout).toContain(`WARNING: ${HOSTS.gemini.keychainNotice}`);
    expect(r.stdout).toContain("agy signs in inside its pane when the run starts (no probe)");
    const m = buildMatrix({
      runId: "r1",
      date: "2026-09-29",
      cli: { version: "28.0.0", revision: "0000000" },
      scenarioDigest: "d",
      catalog: catalogStates(HARNESSES, capabilitiesFor),
      hosts: ["gemini"],
      hostRuns: {
        gemini: { version: "1.2.13", agy_keychain: "real (accepted by the person)", cells: {} },
      },
    });
    expect(m.hosts.gemini.agy_keychain).toBe("real (accepted by the person)");
    const text = renderLedger([
      [
        "gemini",
        {
          version: "1.2.13",
          at: "2026-09-29",
          depth: "install",
          run: {
            id: "r1",
            at: "2026-09-29",
            version: "1.2.13",
            cli: { version: "28.0.0", revision: "0000000" },
            cells: {},
            agy_keychain: "real (accepted by the person)",
          },
        },
      ],
    ]);
    expect(text).toContain('agy_keychain: "real (accepted by the person)"');
  }, 240_000);
});

describe("host-run pane launch: a short typed command, the env -i line in a 0700 launcher", () => {
  // The real shape: macOS's per-user TMPDIR, a longer one for margin, and the
  // run id format (toISOString with ':' and '.' replaced), whose length is fixed.
  const RUN_ID = "2026-12-31T23-59-59Z";
  const TMPDIRS = [
    "/private/var/folders/06/cqtqvjws0jlcr25tsls9tw8m0000gn/T",
    `/private/var/folders/${"x".repeat(60)}/T`,
  ];
  const planAt = (hostId: string, tmp: string, over: Record<string, unknown> = {}) =>
    planIsolation({
      hostId,
      root: `${rootTemplate(tmp, RUN_ID, hostId)}XXXXXX`,
      checkout: "/Users/someone/Git/agent-workflow-cli",
      node: "/Users/someone/.nvm/versions/node/v22.20.0/bin/node",
      hostBin: `/Users/someone/.local/share/${hostId}/versions/9.99.999/bin/${HOSTS[hostId].bin}`,
      realHome: "/Users/someone",
      profile: PROFILES[hostId],
      tokenPresent: true,
      ...over,
    });

  it(`every command typed to launch a pane is at most ${MAX_TYPED_LAUNCH} bytes, for all ${COVERED_HOSTS.length} hosts`, () => {
    expect(COVERED_HOSTS).toHaveLength(5);
    for (const tmp of TMPDIRS) {
      for (const id of COVERED_HOSTS) {
        const p = planAt(id, tmp, { model: "some-long-model-name-v9", effort: "high" });
        const argv = herdrArgv.run("w1:p1", p.pane.command);
        expect(Buffer.byteLength(argv.at(-1) as string), `${id} ${tmp}`).toBeLessThanOrEqual(
          MAX_TYPED_LAUNCH,
        );
        expect(p.pane.command).toBe(`${p.root}/bin/pane-${id}`);
        // The long line is what the launcher holds, never what is typed.
        expect(Buffer.byteLength(p.pane.launchLine)).toBeGreaterThan(MAX_TYPED_LAUNCH);
      }
    }
  });

  it("the launcher is written 0700, runs env -i with exactly the planned variables, and holds no secret", async () => {
    const dir = temp();
    const root = join(dir, "aw-host-run-r1-claude-code-L");
    const p = planIsolation({
      hostId: "claude-code",
      root,
      checkout: "/checkout",
      node: process.execPath,
      hostBin: "/opt/claude",
      realHome: join(dir, "no-home"),
      profile: PROFILES["claude-code"],
      tokenPresent: true,
    });
    await prepareHost(
      { ...p, steps: [] },
      { fs: nodeFs(), run: capturedRun(spawn), secrets: { "claude-code": ANTHROPIC } },
    );
    const path = p.pane.launcher.path;
    expect(statSync(path).mode & 0o777).toBe(0o700);
    const text = readFileSync(path, "utf8");
    expect(text.startsWith("#!/bin/sh\nexec env -i ")).toBe(true);
    const vars = [...text.matchAll(/ ([A-Z_][A-Z0-9_]*)=/g)].map((m) => m[1]);
    expect(vars.sort()).toEqual(Object.keys(p.env).sort());
    // It execs the token wrapper; the token itself never is in it.
    expect(text).toContain(`${root}/bin/launch-claude`);
    expect(text).not.toContain(ANTHROPIC);
    expect(text).not.toMatch(/CLAUDE_CODE_OAUTH_TOKEN/);
    expect(containsSecret(text, [ANTHROPIC])).toBe(false);
  });

  it("a host started through the launcher gets exactly the planned environment", async () => {
    const dir = temp();
    const root = join(dir, "aw-host-run-r1-opencode-E");
    // /usr/bin/env as the host: it prints the environment it was started with.
    const p = planIsolation({
      hostId: "opencode",
      root,
      checkout: "/checkout",
      node: process.execPath,
      hostBin: "/usr/bin/env",
      realHome: join(dir, "no-home"),
      profile: PROFILES.opencode,
    });
    await prepareHost({ ...p, steps: [] }, { fs: nodeFs(), run: capturedRun(spawn), secrets: {} });
    const r = spawnSync(p.pane.command, [], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", LEAKED: "must-not-pass" },
    });
    expect(r.status, r.stderr).toBe(0);
    const got = Object.fromEntries(
      r.stdout
        .trim()
        .split("\n")
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
    expect(got).toEqual(p.env);
  });

  it("the workspace's close hook exists as soon as it is created, even when the launch fails", () => {
    const calls: string[][] = [];
    const hooks: string[] = [];
    const client = new HerdrClient((argv: string[]) => {
      calls.push(argv);
      if (argv[0] === "workspace" && argv[1] === "create")
        return {
          status: 0,
          stdout: JSON.stringify({
            result: { workspace: { workspace_id: "w9" }, root_pane: { pane_id: "w9:p1" } },
          }),
          stderr: "",
        };
      if (argv[0] === "pane" && argv[1] === "run") return { status: 1, stdout: "", stderr: "boom" };
      return { status: 0, stdout: "", stderr: "" };
    });
    expect(() =>
      client.openPane("/w", "host-run-codex", "/r/bin/pane-codex", (ws: string) => hooks.push(ws)),
    ).toThrow();
    expect(hooks).toEqual(["w9"]);
    expect(calls.find((a) => a[1] === "run")).toEqual([
      "pane",
      "run",
      "w9:p1",
      "/r/bin/pane-codex",
    ]);
  });

  it("leftover host-run-* workspaces are found by label in a workspace list", () => {
    const json = {
      result: {
        type: "workspace_list",
        workspaces: [
          { workspace_id: "w1", label: "host-run-claude-code" },
          { workspace_id: "w2", label: "my-project" },
          { workspace_id: "w3", label: "host-run-crush" },
          { label: "host-run-broken" },
        ],
      },
    };
    expect(leftoverWorkspaces(json)).toEqual([
      { id: "w1", label: "host-run-claude-code" },
      { id: "w3", label: "host-run-crush" },
    ]);
    expect(leftoverWorkspaces(null)).toEqual([]);
    // run.mjs offers to close them at the next start, before preparing anything.
    const src = readFileSync(RUN, "utf8");
    expect(src).toContain("await offerToCloseLeftovers(herdr);");
    expect(src.indexOf("await offerToCloseLeftovers(herdr);")).toBeLessThan(
      src.indexOf("await live.prepareAll("),
    );
  });
});
