import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { worklineMarkerContent } from "../../src/runtime/workline-marker.js";

/**
 * The names 29.0.0 retired answer RENAMED through the real binary, with their
 * replacement, without a single write — in a hub and outside one (plan 086, F1).
 *
 * Run after `npm run build`: the guard lives in the entry an agent calls.
 */

const run = promisify(execFile);
const CLI = resolve(__dirname, "..", "..", "dist", "cli", "main.js");

const RETIRED: { argv: string[]; replacement: string }[] = [
  { argv: ["workspace-init"], replacement: "hub-init" },
  { argv: ["workspace-move", "../otro"], replacement: "hub-move" },
  { argv: ["workspace-commit", "prepare", "--code", "001"], replacement: "hub-commit" },
  { argv: ["workspace-migrate", "--apply"], replacement: "hub-migrate" },
  { argv: ["project-md-upsert", "--init", "--proyecto", "x"], replacement: "hub-block" },
  { argv: ["status", "--workspace", "."], replacement: "--hub" },
  { argv: ["hub-init", "--proyecto", "x"], replacement: "--nombre" },
  { argv: ["workspace-init", "--help"], replacement: "hub-init" },
];

let root: string;
let home: string;
let bare: string;
let hub: string;

/** Every file under `dir` with its size and content digest: what a write would move. */
async function tree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (current: string) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        out[`${relative(dir, path)}/`] = "dir";
        await walk(path);
      } else {
        const digest = createHash("sha256")
          .update(await readFile(path))
          .digest("hex");
        out[relative(dir, path)] = `${(await stat(path)).size}:${digest}`;
      }
    }
  };
  await walk(dir);
  return out;
}

async function aw(cwd: string, argv: string[]) {
  const outcome = await run(process.execPath, [CLI, ...argv, "--json"], {
    cwd,
    env: { ...process.env, HOME: home, AW_NAMESPACE: "workflow" },
    encoding: "utf8",
  }).then(
    (ok) => ({ code: 0, stdout: ok.stdout }),
    (error: { code?: number; stdout?: string }) => ({
      code: error.code ?? -1,
      stdout: error.stdout ?? "",
    }),
  );
  return { code: outcome.code, body: JSON.parse(outcome.stdout) as Record<string, unknown> };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "aw-renamed-"));
  home = join(root, "home");
  bare = join(root, "bare");
  hub = join(root, "hub");
  await mkdir(home, { recursive: true });
  await mkdir(bare, { recursive: true });
  await mkdir(join(hub, ".workflow", "sessions"), { recursive: true });
  await writeFile(join(hub, ".workflow", "workline.json"), worklineMarkerContent("workflow"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("retired names answer RENAMED with no effects", () => {
  for (const where of ["no hub", "hub"] as const) {
    it.each(RETIRED)(`$argv (${where})`, async ({ argv, replacement }) => {
      const cwd = where === "hub" ? hub : bare;
      const before = await tree(root);
      const { code, body } = await aw(cwd, argv);
      expect(code).toBe(1);
      expect(body).toMatchObject({ ok: false, error: { code: "RENAMED" } });
      expect((body.error as { message: string }).message).toContain(replacement);
      expect(await tree(root)).toEqual(before);
    });
  }

  it.each(RETIRED)("$argv answers the same in and out of a hub", async ({ argv }) => {
    expect(await aw(hub, argv)).toEqual(await aw(bare, argv));
  });
});
