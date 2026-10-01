import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerHub } from "../../src/application/hub-registry.js";
import { PathsService } from "../../src/application/paths-service.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { worklineMarkerContent } from "../../src/runtime/workline-marker.js";
import { NodeFileSystem } from "../helpers/real-fs.js";

/**
 * A hub whose block still wears the pre-29 `<NS>-PROJECT-*` markers answers no
 * command until `aw hub-migrate --apply` runs — in the hub and from a source
 * that declares it — except the migration itself, doctor and help (plan 086, F3).
 *
 * Run after `npm run build`: the guard lives in the binary's entry.
 */

const run = promisify(execFile);
const CLI = resolve(__dirname, "..", "..", "dist", "cli", "main.js");

let root: string;
let home: string;
let hub: string;
let source: string;

function legacyBlock(namespace: string): string {
  const upper = namespace.toUpperCase();
  return [
    `<!-- ${upper}-PROJECT-START -->`,
    "## Proyecto",
    "",
    "Hub de prueba",
    "",
    "## Fuentes",
    "",
    "| Alias | Path | Rama principal |",
    "|---|---|---|",
    `| app | ${source} | main |`,
    `<!-- ${upper}-PROJECT-END -->`,
    "",
  ].join("\n");
}

async function aw(cwd: string, ...args: string[]) {
  const outcome = await run(process.execPath, [CLI, ...args, "--json"], {
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
  const body = outcome.stdout.trimStart().startsWith("{")
    ? (JSON.parse(outcome.stdout) as Record<string, unknown>)
    : { text: outcome.stdout };
  return { code: outcome.code, body };
}

function errorOf(body: Record<string, unknown>) {
  return body.error as { code: string; message: string } | undefined;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "aw-hub-migration-"));
  home = join(root, "home");
  hub = join(root, "hub");
  source = join(root, "app");
  await mkdir(home);
  await mkdir(source);
  await run("git", ["init", "-q", "-b", "main", source]);
  await mkdir(join(hub, ".workflow", "sessions"), { recursive: true });
  await writeFile(join(hub, ".workflow", "workline.json"), worklineMarkerContent("workflow"));
  await writeFile(join(hub, "CLAUDE.md"), legacyBlock("workflow"));
  await writeFile(join(hub, "AGENTS.md"), legacyBlock("workflow"));
  const namespace = normalizeNamespace("workflow");
  await registerHub(new NodeFileSystem(), new PathsService(namespace, home, hub), hub);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("a hub with PROJECT markers demands the migration", () => {
  it("status fails with HUB_MIGRATION_REQUIRED and names the command", async () => {
    const { code, body } = await aw(hub, "status");
    expect(code).toBe(1);
    expect(errorOf(body)?.code).toBe("HUB_MIGRATION_REQUIRED");
    expect(errorOf(body)?.message).toContain("aw hub-migrate --apply");
    expect((body.data as { action?: string }).action).toBe("aw hub-migrate --apply");
  });

  it("an older namespace's PROJECT block also demands it", async () => {
    await writeFile(join(hub, "CLAUDE.md"), legacyBlock("agent-workflow"));
    await writeFile(join(hub, "AGENTS.md"), legacyBlock("agent-workflow"));
    expect(errorOf((await aw(hub, "status")).body)?.code).toBe("HUB_MIGRATION_REQUIRED");
  });

  it("from a source checkout that the hub declares, the walk-up answers the same", async () => {
    const { code, body } = await aw(source, "status");
    expect(code).toBe(1);
    expect(errorOf(body)?.code).toBe("HUB_MIGRATION_REQUIRED");
  });

  it("hub-migrate, doctor and --help still answer", async () => {
    expect((await aw(hub, "hub-migrate")).code).toBe(0);
    expect(errorOf((await aw(hub, "doctor")).body)?.code).not.toBe("HUB_MIGRATION_REQUIRED");
    const help = await aw(hub, "status", "--help");
    expect(help.code).toBe(0);
    expect(String(help.body.text)).toContain("Usage: aw status");
  });

  it("after hub-migrate --apply the block wears HUB markers and status answers", async () => {
    expect((await aw(hub, "hub-migrate", "--apply")).code).toBe(0);
    const claude = await readFile(join(hub, "CLAUDE.md"), "utf8");
    expect(claude).toContain("<!-- WORKFLOW-HUB-START -->");
    expect(claude).toContain("## Hub\n");
    expect(claude).not.toContain("PROJECT");
    expect((await aw(hub, "status")).code).toBe(0);
    expect((await aw(source, "status")).code).toBe(0);
  });
});
