import { execFile } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SESSION_FLAGS,
  fitsContract,
  nextStepOfError,
  retryWith,
} from "../../src/cli/next-step-emit.js";
import { FLOW_DECISIONS, actionOf } from "../../src/domain/flow/authority.js";
import { SESSION_SHAPES, bindAction } from "../../src/domain/flow/rules.js";
import { commandIn, nextStepOf } from "../../src/domain/next-step.js";
import { worklineMarkerContent } from "../../src/runtime/workline-marker.js";

/**
 * Every error with a determinable next step names the exact command (plan 082,
 * F4 · spec 061 AC-05), and none chooses between two exits.
 *
 * Run after `npm run build`: the determinable cases are exercised through the
 * binary, where the typed `data.next_step` is emitted.
 */

const REPO = resolve(__dirname, "..", "..");
const CLI = join(REPO, "dist", "cli", "main.js");
const FIXTURE = join(REPO, "tests", "fixtures", "error-actions.json");
const run = promisify(execFile);

interface Classified {
  file: string;
  text: string;
  class: "interpolated" | "not-determinable" | "usage";
  reason: string;
}

/** Every `aw …` in the source that still spells a placeholder, as `file | text`. */
function placeholderActions(): Set<string> {
  const pattern = /aw [a-z][a-z-]*(?: [^`'"\n]*?)?<[^>\n]+>/g;
  const found = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts")) {
        collectPlaceholderActions(path, pattern, found);
      }
    }
  };
  walk(join(REPO, "src"));
  return found;
}

async function aw(cwd: string, ...args: string[]) {
  const outcome = await run(process.execPath, [CLI, ...args, "--json"], {
    cwd,
    encoding: "utf8",
  }).catch((error: { stdout: string }) => error);
  return JSON.parse(outcome.stdout) as {
    error?: { code: string };
    data?: { action?: string; next_step?: { command?: string; alternatives?: string[] } };
  };
}

describe("every placeholder action is classified", () => {
  const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as { actions: Classified[] };

  it("no action with a placeholder is left unclassified, and none classified is stale", () => {
    const classified = new Set(fixture.actions.map((a) => `${a.file} | ${a.text}`));
    const found = placeholderActions();
    expect([...found].filter((key) => !classified.has(key))).toEqual([]);
    expect([...classified].filter((key) => !found.has(key))).toEqual([]);
  });

  it("each classification says why", () => {
    for (const action of fixture.actions) {
      expect(["interpolated", "not-determinable", "usage"], action.text).toContain(action.class);
      expect(action.reason.trim(), action.text).not.toBe("");
    }
  });

  it("an interpolated recovery reaches the directive with the run's own coordinates", () => {
    const binding = { session: "001-x-plan-exec", code: "001", slug: "x" };
    const slot = new RegExp(
      `(--code|--session|--name) (${[...SESSION_SHAPES, "<slug>"].join("|")})`,
    );
    const recoveries = new Map<string, string>();
    for (const row of FLOW_DECISIONS) {
      const action = actionOf(row);
      if (action === null) continue;
      const bound = bindAction(action, binding);
      if (!bound.ok) continue;
      expect(bound.action.recovery, row.id).not.toMatch(slot);
      recoveries.set(row.id, bound.action.recovery);
    }
    expect(recoveries.get("plan-exec.batch-inference")).toContain("--session 001-x-plan-exec");
    expect(recoveries.get("plan-exec.unit-acquisition")).toContain("--code 001-x-plan-exec");
    expect(recoveries.get("quick.session-create")).toContain("--name x-quick");
  });
});

describe("the typed next step", () => {
  it("is the one runnable command an action names", () => {
    expect(commandIn("corré `aw status` y reintentá")).toBe("aw status");
  });

  it("derives nothing from two commands: steps in order and alternatives read the same", () => {
    expect(commandIn("revisá 'aw worktree list' y reintentá con 'aw flow advance'")).toBeNull();
  });

  it("invents nothing for a shape that still holds a placeholder", () => {
    expect(commandIn("indicá la sesión con `aw x --code <NNN>`")).toBeNull();
    expect(commandIn("revisá la configuración")).toBeNull();
  });

  it("lists alternatives without choosing when several are valid", () => {
    expect(nextStepOf(["aw a --code 1", "aw a --code 2"])).toEqual({
      alternatives: ["aw a --code 1", "aw a --code 2"],
    });
  });

  it("offers no retry of a command that reads stdin, wherever the global flags sit", () => {
    const data = { choose: true, candidates: [{ folder: "001-x-quick" }] };
    expect(nextStepOfError(data, ["--hub", "/w", "flow", "submit"])).toBeNull();
    expect(nextStepOfError(data, ["export-scripts", "apply"])).toBeNull();
    expect(nextStepOfError(data, ["flow", "advance"])?.next_step).toEqual({
      command: "aw flow advance --code 001-x-quick",
    });
  });

  it("a retry drops every spelling of the session flag before naming --code", () => {
    for (const alias of ["--code", "--session", "--sesion"]) {
      expect(retryWith(["flow", "advance", alias, "001", "--json"], SESSION_FLAGS, "001-x")).toBe(
        "aw flow advance --json --code 001-x",
      );
    }
    expect(retryWith(["x", "--session=001"], SESSION_FLAGS, "a b")).toBe("aw x --code 'a b'");
  });

  it("only publishes a command the CLI's own contract accepts as written", () => {
    expect(fitsContract("aw status")).toBe(true);
    expect(fitsContract("aw flow advance --session 001-x-quick --flow quick --adopt")).toBe(true);
    expect(fitsContract("aw hub-migrate --renumber")).toBe(true);
    expect(fitsContract("aw session-create")).toBe(false);
    expect(fitsContract("aw discard")).toBe(false);
    expect(fitsContract("aw flow")).toBe(false);
    expect(fitsContract("aw status --bogus")).toBe(false);
    expect(fitsContract("aw status --json --detail")).toBe(true);
    expect(fitsContract("aw nope")).toBe(false);
  });
});

describe("determinable errors name the exact command — through the binary", () => {
  let root: string;
  let ws: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "aw-error-actions-"));
    ws = join(root, "ws");
    await mkdir(join(ws, ".workflow", "sessions"), { recursive: true });
    await mkdir(join(ws, "sub"), { recursive: true });
    await writeFile(join(ws, ".workflow", "workline.json"), worklineMarkerContent("workflow"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function session(folder: string) {
    await mkdir(join(ws, ".workflow", "sessions", folder), { recursive: true });
    await writeFile(
      join(ws, ".workflow", "sessions", folder, "SESSION.md"),
      "# SESSION\n\n## Objective\nprueba\n",
    );
  }

  it("SESSION_UNBOUND with one active session: the same invocation with its --code", async () => {
    await session("001-uno-quick");
    const out = await aw(ws, "flow", "advance");
    expect(out.error?.code).toBe("SESSION_UNBOUND");
    expect(out.data?.next_step).toEqual({
      command: "aw flow advance --json --code 001-uno-quick",
    });
    expect(out.data?.action).toContain("aw flow advance --json --code 001-uno-quick");
  });

  it("two active sessions: both listed as alternatives, none chosen", async () => {
    await session("001-uno-quick");
    await session("002-dos-quick");
    const out = await aw(ws, "flow", "advance");
    expect(out.error?.code).toBe("SESSION_UNBOUND");
    expect(out.data?.next_step).toEqual({
      alternatives: [
        "aw flow advance --json --code 001-uno-quick",
        "aw flow advance --json --code 002-dos-quick",
      ],
    });
    expect(out.data?.next_step?.command).toBeUndefined();
  });

  it("two folders sharing a correlative: no retry is offered, the repair command is", async () => {
    await session("001-uno-quick");
    await session("session001-viejo");
    const out = await aw(ws, "flow", "advance", "--code", "001");
    expect(out.error?.code).toBe("SESSION_AMBIGUOUS");
    expect(out.data?.next_step).toEqual({ command: "aw hub-migrate --renumber" });
  });

  it("FLOW_RUN_ABSENT: --session and --flow come from the adoptable session", async () => {
    await session("001-uno-quick");
    const out = await aw(ws, "flow", "advance", "--session", "001");
    expect(out.error?.code).toBe("FLOW_RUN_ABSENT");
    expect(out.data?.next_step).toEqual({
      command: "aw flow advance --session 001-uno-quick --flow quick --adopt",
    });
  });

  it("ARGS_INVALID of flow and export: the usage generated from the contract", async () => {
    const flow = await aw(ws, "flow", "retract", "--session", "001");
    expect(flow.error?.code).toBe("ARGS_INVALID");
    expect(flow.data?.action).toContain("aw flow retract [--code <code>]");
    expect(flow.data?.action).toContain("--signal <signal>");
    const exported = await aw(ws, "export-scripts", "bogus");
    expect(exported.error?.code).toBe("ARGS_INVALID");
    expect(exported.data?.action).toContain("aw export-scripts <action>");
  });

  it("WORKSPACE_INVALID inside a workspace: the same invocation on its root", async () => {
    const out = await aw(root, "status", "--hub", join(ws, "sub"));
    expect(out.error?.code).toBe("WORKSPACE_INVALID");
    expect(out.data?.next_step?.command).toMatch(/^aw status --json --hub \S+\/ws$/);
  });
});

function collectPlaceholderActions(path: string, pattern: RegExp, found: Set<string>): void {
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("*") || trimmed.startsWith("//")) continue;
    for (const match of line.matchAll(pattern)) {
      found.add(`${relative(REPO, path)} | ${match[0]}`);
    }
  }
}
