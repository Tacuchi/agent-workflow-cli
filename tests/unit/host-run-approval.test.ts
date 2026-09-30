// The host run starts only with a person's typed approval in a real terminal
// (plan 085, T1.4, AC-08): without a TTY, from inside an agent host, or without
// the exact digest, nothing is prepared and no pane is opened.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentAncestor,
  agentMarkers,
  approvalDigest,
  approves,
  parseArgs,
  processChain,
  refusal,
} from "../../scripts/host-run/approval.mjs";
import { COVERED_HOSTS } from "../../scripts/host-run/hosts.mjs";
import { launch } from "../../scripts/host-run/launch.mjs";
import { HARNESSES } from "../../src/domain/harnesses.js";

const ROOT = join(__dirname, "..", "..");
const RUN = join(ROOT, "scripts", "host-run", "run.mjs");
const DIST = join(ROOT, "dist", "cli", "main.js");
const markers = agentMarkers(HARNESSES);

function deps(over: Record<string, unknown> = {}) {
  return {
    stdinIsTTY: true,
    stdoutIsTTY: true,
    env: {},
    markers,
    digest: "abcdef012345",
    show: vi.fn(),
    ask: vi.fn(async () => "abcdef012345"),
    start: vi.fn(async () => 0),
    log: vi.fn(),
    ...over,
  };
}

/** Only the variables a spawned run needs, with a synthetic HOME and TMPDIR. */
function isolatedEnv(dir: string): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, HOME: join(dir, "home"), TMPDIR: join(dir, "tmp") };
}

describe("host-run approval gate", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("refuses without a TTY on stdin or stdout", () => {
    expect(refusal({ stdinIsTTY: false, stdoutIsTTY: true, env: {}, markers })).toMatch(
      /real terminal/,
    );
    expect(refusal({ stdinIsTTY: true, stdoutIsTTY: false, env: {}, markers })).toMatch(
      /real terminal/,
    );
    expect(refusal({ stdinIsTTY: true, stdoutIsTTY: true, env: {}, markers })).toBeNull();
  });

  it("refuses when an agent host or a Herdr pane launched it", () => {
    for (const marker of [
      "CLAUDECODE",
      "CODEX_THREAD_ID",
      "CODEX_SANDBOX",
      "OPENCODE",
      "HERDR_PANE_ID",
      "ANTIGRAVITY_CLI",
    ]) {
      const why = refusal({ stdinIsTTY: true, stdoutIsTTY: true, env: { [marker]: "1" }, markers });
      expect(why, marker).toMatch(/inside an agent host/);
    }
  });

  it("refuses when an agent host or Herdr is among the ancestors", () => {
    const table: Record<number, { ppid: number; args: string }> = {
      40: { ppid: 30, args: "-zsh" },
      30: { ppid: 20, args: "node /opt/homebrew/lib/node_modules/@openai/codex/bin/codex" },
      20: { ppid: 1, args: "/Applications/Warp.app/Contents/MacOS/stable" },
    };
    const chain = processChain(40, (pid: number) => table[pid] ?? null);
    expect(chain.map((c) => c.pid)).toEqual([40, 30, 20]);
    const ancestor = agentAncestor(chain);
    expect(ancestor).toBe("codex (pid 30)");
    expect(refusal({ stdinIsTTY: true, stdoutIsTTY: true, env: {}, markers, ancestor })).toMatch(
      /ancestor codex/,
    );
    expect(agentAncestor([{ pid: 9, args: "/Users/x/.local/bin/herdr server" }])).toBe(
      "herdr (pid 9)",
    );
    expect(
      agentAncestor([
        { pid: 8, args: "-zsh" },
        { pid: 7, args: "login -pf x" },
      ]),
    ).toBeNull();
  });

  it("launch consults the ancestry before showing anything", async () => {
    const d = deps({ ancestor: () => "claude (pid 12)" });
    expect(await launch(d)).toBe(1);
    expect(d.show).not.toHaveBeenCalled();
    expect(d.start).not.toHaveBeenCalled();
  });

  it("Warp's terminal marker is not an agent: the person may launch from Warp", () => {
    expect(markers).not.toContain("WARP_IS_LOCAL_SHELL_SESSION");
    expect(
      refusal({
        stdinIsTTY: true,
        stdoutIsTTY: true,
        env: { WARP_IS_LOCAL_SHELL_SESSION: "1" },
        markers,
      }),
    ).toBeNull();
  });

  it("does not take a config pointer a person may export for an agent marker", () => {
    expect(markers).not.toContain("CODEX_HOME");
    expect(markers).not.toContain("OPENCODE_CONFIG");
  });

  it("no TTY: nothing is asked, prepared or opened", async () => {
    const d = deps({ stdinIsTTY: false });
    expect(await launch(d)).toBe(1);
    expect(d.ask).not.toHaveBeenCalled();
    expect(d.start).not.toHaveBeenCalled();
  });

  it("agent host: refused before anything is shown", async () => {
    const d = deps({ env: { CLAUDECODE: "1" } });
    expect(await launch(d)).toBe(1);
    expect(d.show).not.toHaveBeenCalled();
    expect(d.start).not.toHaveBeenCalled();
  });

  it("a wrong, partial or missing digest opens nothing", async () => {
    for (const typed of ["", "abcdef", "ABCDEF012345", "yes", "abcdef0123456"]) {
      const d = deps({ ask: vi.fn(async () => typed) });
      expect(await launch(d), typed).toBe(1);
      expect(d.start, typed).not.toHaveBeenCalled();
    }
  });

  it("only the exact digest starts the run", async () => {
    const d = deps({ ask: vi.fn(async () => "  abcdef012345\n") });
    expect(await launch(d)).toBe(0);
    expect(d.start).toHaveBeenCalledTimes(1);
    expect(approves("abcdef012345", "abcdef012345")).toBe(true);
  });

  it("the digest seals the scenario and the profiles", () => {
    const scenario = { steps: [{ surface: "commands" }] };
    const a = approvalDigest(scenario, { codex: { deny: ["x"] } });
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(approvalDigest(scenario, { codex: { deny: ["x"] } })).toBe(a);
    expect(approvalDigest(scenario, { codex: { deny: ["y"] } })).not.toBe(a);
    expect(approvalDigest({ steps: [] }, { codex: { deny: ["x"] } })).not.toBe(a);
  });

  it("takes model and effort per host and refuses anything else", () => {
    const args = parseArgs(
      ["--model", "codex=gpt-x", "--effort", "claude-code=high", "--dry-run"],
      COVERED_HOSTS,
    );
    expect(args).toMatchObject({
      dryRun: true,
      model: { codex: "gpt-x" },
      effort: { "claude-code": "high" },
    });
    expect(() => parseArgs(["--model", "warp=x"], COVERED_HOSTS)).toThrow();
    expect(() => parseArgs(["--yes"], COVERED_HOSTS)).toThrow(/unknown argument/);
  });

  it.skipIf(!existsSync(DIST))("run.mjs without a TTY exits non-zero and creates nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "host-run-approval-"));
    dirs.push(dir);
    const env = isolatedEnv(dir);
    spawnSync("mkdir", ["-p", env.TMPDIR as string, env.HOME as string]);
    const r = spawnSync(process.execPath, [RUN], { env, encoding: "utf8", input: "" });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/real terminal/);
    expect(readdirSync(env.TMPDIR as string)).toEqual([]);
  });

  it.skipIf(!existsSync(DIST))("run.mjs --dry-run prepares nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "host-run-dry-"));
    dirs.push(dir);
    const env = isolatedEnv(dir);
    spawnSync("mkdir", ["-p", env.TMPDIR as string, env.HOME as string]);
    const r = spawnSync(process.execPath, [RUN, "--dry-run"], { env, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("Approval digest:");
    expect(r.stdout).toContain("env -i HOME=");
    expect(readdirSync(env.TMPDIR as string)).toEqual([]);
    expect(readdirSync(env.HOME as string)).toEqual([]);
  });

  it.skipIf(!existsSync(DIST))("the digest also seals model/effort and the pane commands", () => {
    const dir = mkdtempSync(join(tmpdir(), "host-run-digest-"));
    dirs.push(dir);
    const env = isolatedEnv(dir);
    spawnSync("mkdir", ["-p", env.TMPDIR as string, env.HOME as string]);
    const digestOf = (...extra: string[]) => {
      const r = spawnSync(process.execPath, [RUN, "--dry-run", ...extra], {
        env,
        encoding: "utf8",
      });
      return /Approval digest: ([0-9a-f]{12})/.exec(r.stdout)?.[1];
    };
    const base = digestOf();
    expect(base).toMatch(/^[0-9a-f]{12}$/);
    expect(digestOf()).toBe(base);
    expect(digestOf("--model", "codex=gpt-x")).not.toBe(base);
    expect(digestOf("--effort", "claude-code=high")).not.toBe(base);
    expect(digestOf("--agy-without-profile")).not.toBe(base);
  });
});
