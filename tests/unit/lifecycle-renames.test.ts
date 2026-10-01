import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PathsService } from "../../src/application/paths-service.js";
import {
  resolveBundledHookTemplate,
  selfInstallHooks,
} from "../../src/application/self/install-hooks.js";
import type { ParsedArgs } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { worklineMarkerContent } from "../../src/runtime/workline-marker.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { FakeProcess } from "../helpers/fake-process.js";
import { NoScanFs } from "../helpers/real-fs.js";

/**
 * The resume and hook names 29.0.0 retired (plan 087, F5), through the real
 * binary: run after `npm run build`.
 */

const exec = promisify(execFile);
const CLI = resolve(__dirname, "..", "..", "dist", "cli", "main.js");

const RETIRED = [
  { argv: ["session-resume", "--code", "001"], replacement: "session-load" },
  { argv: ["resume-summary"], replacement: "hook post-compact" },
  { argv: ["auto-compact-on-close"], replacement: "hook session-end" },
];

/** What the old template wrote into a host's hook config. */
const OLD_COMMANDS = [
  "agent-workflow checkpoint-write",
  "agent-workflow resume-summary",
  "agent-workflow auto-compact-on-close",
];

let root: string;
let home: string;
let bare: string;
let hub: string;

async function tree(dir: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const name of await readdir(dir, { recursive: true })) {
    out[name] = (await stat(join(dir, name))).size;
  }
  return out;
}

async function aw(cwd: string, argv: string[], stdin = "") {
  const child = exec(process.execPath, [CLI, ...argv], {
    cwd,
    env: { ...process.env, HOME: home, AW_NAMESPACE: "workflow" },
    encoding: "utf8",
  });
  child.child.stdin?.end(stdin);
  return child.then(
    (ok) => ({ code: 0, stdout: ok.stdout, stderr: ok.stderr }),
    (error: { code?: number; stdout?: string; stderr?: string }) => ({
      code: error.code ?? -1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    }),
  );
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "aw-lifecycle-renames-"));
  home = join(root, "home");
  bare = join(root, "bare");
  hub = join(root, "hub");
  await mkdir(home, { recursive: true });
  await mkdir(bare, { recursive: true });
  await mkdir(join(hub, ".workflow", "sessions", "001-prueba-quick"), { recursive: true });
  await writeFile(join(hub, ".workflow", "workline.json"), worklineMarkerContent("workflow"));
  await writeFile(
    join(hub, ".workflow", "sessions", "001-prueba-quick", "SESSION.md"),
    "# SESSION — prueba\n\n## Objective\nprobar\n\n## Type\nquick\n",
  );
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("los nombres retirados responden RENAMED y no ejecutan nada", () => {
  for (const where of ["sin hub", "hub"] as const) {
    it.each(RETIRED)(`$argv (${where})`, async ({ argv, replacement }) => {
      const cwd = where === "hub" ? hub : bare;
      const before = await tree(root);
      const { code, stdout } = await aw(cwd, [...argv, "--json"]);
      expect(code).toBe(1);
      const body = JSON.parse(stdout);
      expect(body).toMatchObject({ ok: false, error: { code: "RENAMED" } });
      expect(body.error.message).toContain(replacement);
      expect(await tree(root)).toEqual(before);
    });
  }
});

describe("aw hook <evento>", () => {
  it.each(["pre-compact", "post-compact", "session-end"])(
    "%s fuera de un hub sale 0 en silencio",
    async (event) => {
      const before = await tree(root);
      const { code, stdout, stderr } = await aw(bare, ["hook", event], "{}");
      expect(code).toBe(0);
      expect(stdout).toBe("");
      expect(stderr).toBe("");
      expect(await tree(root)).toEqual(before);
    },
  );

  it("un subcomando desconocido sigue rechazado", async () => {
    const { code, stdout } = await aw(bare, ["hook", "resume-summary"]);
    expect(code).toBe(1);
    expect(JSON.parse(stdout).error.message).toContain("unknown subcommand 'resume-summary'");
  });
});

describe("aw checkpoint-write sigue saliendo con 0 como el PreCompact de un host sin reinstalar", () => {
  it("en un hub con marcadores anteriores a 29.0.0 avisa por stderr y sale con 0", async () => {
    const old = join(root, "old-hub");
    await mkdir(join(old, ".workflow", "sessions"), { recursive: true });
    await writeFile(join(old, ".workflow", "workline.json"), worklineMarkerContent("workflow"));
    await writeFile(
      join(old, "CLAUDE.md"),
      "<!-- WORKFLOW-PROJECT-START -->\n## Proyecto\nviejo\n<!-- WORKFLOW-PROJECT-END -->\n",
    );
    const { code, stdout, stderr } = await aw(old, ["checkpoint-write"], "{}");
    expect(code).toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toContain("hub-migrate");
  });
});

describe("aw checkpoint-write --code queda para los agentes", () => {
  it("escribe el CHECKPOINT de la sesión nombrada", async () => {
    const { code } = await aw(hub, ["checkpoint-write", "--code", "001", "--json"]);
    expect(code).toBe(0);
    const checkpoint = join(hub, ".workflow", "sessions", "001-prueba-quick", "CHECKPOINT.md");
    expect((await stat(checkpoint)).isFile()).toBe(true);
  });
});

describe("reinstalar deja los hooks de cada host sólo con los nombres nuevos", () => {
  function ctx(host: string): CliContext {
    const ns = normalizeNamespace("agent-workflow");
    return {
      fs: new NoScanFs(),
      env: new FakeEnv(host),
      process: new FakeProcess({ run: () => ({ code: 0, stdout: "", stderr: "" }) }),
      git: {} as never,
      namespace: { namespace: ns, source: "default" },
      runtime: {
        packageName: "@tacuchi/agent-workflow-cli",
        binName: "agent-workflow",
        source: "default",
      },
      paths: new PathsService(ns, host, host),
    } as CliContext;
  }
  const args = (target: string, template: string): ParsedArgs => ({
    rest: ["install-hooks"],
    plugin: {},
    flags: new Set(),
    values: new Map([
      ["target", target],
      ["template", template],
    ]),
    valuesMulti: new Map(),
  });

  it.each([
    ["claude", ".claude/settings.json"],
    ["kimi", ".kimi-code/config.toml"],
  ])("%s", async (target, file) => {
    const host = join(root, `install-${target}`);
    await mkdir(join(host, relative(".", file), ".."), { recursive: true });
    const old = join(root, `old-${target}.json`);
    await writeFile(
      old,
      JSON.stringify({
        hooks: {
          SessionEnd: [{ matcher: "", hooks: [{ type: "command", command: OLD_COMMANDS[2] }] }],
          PreCompact: [{ matcher: "", hooks: [{ type: "command", command: OLD_COMMANDS[0] }] }],
          PostCompact: [{ matcher: "", hooks: [{ type: "command", command: OLD_COMMANDS[1] }] }],
        },
      }),
    );
    expect((await selfInstallHooks(args(target, old), ctx(host))).ok).toBe(true);
    const before = await readFile(join(host, file), "utf8");
    expect(OLD_COMMANDS.some((command) => before.includes(command))).toBe(true);

    const bundled = await resolveBundledHookTemplate();
    if (bundled === null) throw new Error("la plantilla del bundle no se resolvió");
    expect((await selfInstallHooks(args(target, bundled), ctx(host))).ok).toBe(true);
    const after = await readFile(join(host, file), "utf8");
    for (const command of OLD_COMMANDS) expect(after, target).not.toContain(`${command}"`);
    expect(after).toContain("agent-workflow hook session-end");
    if (target === "claude") {
      expect(after).toContain("agent-workflow hook pre-compact");
      expect(after).toContain("agent-workflow hook post-compact");
    }
  });
});
