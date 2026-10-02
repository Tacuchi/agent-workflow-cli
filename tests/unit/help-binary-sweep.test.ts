import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALL_COMMANDS } from "../../src/cli/commands/index.js";
import { worklineMarkerContent } from "../../src/runtime/workline-marker.js";
import { helpProblems } from "../helpers/help-check.js";

/**
 * Every command and action answers `--help` on its own, through the real
 * binary, inside and outside a workspace (plan 082, F2 · spec 061 AC-02, AC-04).
 *
 * Run after `npm run build`: what is swept is `dist/cli/main.js`, the entry an
 * agent actually calls, so a help that only exists in the source tree fails.
 */

const run = promisify(execFile);
const CLI = resolve(__dirname, "..", "..", "dist", "cli", "main.js");

interface Target {
  command: (typeof ALL_COMMANDS)[number];
  action?: string;
}

const TARGETS: Target[] = ALL_COMMANDS.flatMap((command) => [
  { command },
  ...Object.keys(command.flags.actions ?? {}).map((action) => ({ command, action })),
]);

function label({ command, action }: Target): string {
  return action === undefined ? command.name : `${command.name} ${action}`;
}

async function helpOf(target: Target, cwd: string) {
  const argv = [CLI, target.command.name, ...(target.action ? [target.action] : []), "--help"];
  try {
    const { stdout } = await run(process.execPath, argv, { cwd, encoding: "utf8", env });
    return { code: 0, stdout };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string };
    return { code: failed.code ?? -1, stdout: failed.stdout ?? "" };
  }
}

/** Run `fn` over `items`, `limit` at a time. */
async function pooled<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>) {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < items.length) {
        const index = next++;
        out[index] = await fn(items[index] as T);
      }
    }),
  );
  return out;
}

let root: string;
let bare: string;
let hub: string;
let env: NodeJS.ProcessEnv;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "aw-help-sweep-"));
  bare = join(root, "bare");
  hub = join(root, "ws");
  env = { ...process.env, HOME: join(root, "home"), USERPROFILE: join(root, "home") };
  await mkdir(join(root, "home"), { recursive: true });
  await mkdir(bare, { recursive: true });
  await mkdir(join(hub, ".workflow", "sessions"), { recursive: true });
  await writeFile(
    join(hub, ".workflow", "workline.json"),
    worklineMarkerContent("workflow"),
    "utf8",
  );
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("aw <command> [<action>] --help — through the binary", () => {
  it("every command and action has its own complete English help, in and out of a workspace", async () => {
    const problems: string[] = [];
    const results = await pooled(
      TARGETS.flatMap((target) => [
        { target, cwd: () => bare },
        { target, cwd: () => hub },
      ]),
      8,
      async ({ target, cwd }) => ({ target, where: cwd(), help: await helpOf(target, cwd()) }),
    );
    for (const { target, where, help } of results) {
      const name = `${label(target)} (${where === bare ? "no workspace" : "workspace"})`;
      const { command, action } = target;
      if (help.code !== 0) {
        problems.push(`${name}: exit ${help.code}`);
        continue;
      }
      problems.push(...helpProblems(command, action, help.stdout));
    }
    expect(problems).toEqual([]);
  }, 180_000);
});

describe("errors and directives stay in Spanish", () => {
  it("an unknown flag is refused in Spanish", async () => {
    const { stdout } = await run(process.execPath, [CLI, "status", "--bogus", "--json"], {
      cwd: hub,
      encoding: "utf8",
      env,
    }).catch((error: { stdout: string }) => error);
    expect(stdout).toContain("no es un flag de este comando");
  });

  it("a flow directive is still written in Spanish", async () => {
    const session = join(hub, ".workflow", "sessions", "001-ayuda-quick");
    await mkdir(session, { recursive: true });
    await writeFile(join(session, "SESSION.md"), "# SESSION\n\n## Objective\nayuda\n", "utf8");
    const { stdout } = await run(
      process.execPath,
      [CLI, "flow", "advance", "--session", "001", "--flow", "quick", "--adopt", "--json"],
      { cwd: hub, encoding: "utf8", env },
    );
    expect(JSON.parse(stdout).next_action).toMatch(/respondé|ejecutá|corré/);
  });
});
