import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HerdrCli } from "../../src/adapters/herdr-cli.js";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import type { HubStatus } from "../../src/application/hubs-status-service.js";
import { runHubsSync } from "../../src/application/hubs-sync-service.js";
import { hubsCommand } from "../../src/cli/commands/hubs.js";
import { parseArgv } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
import { worklineMarkerContent } from "../../src/runtime/workline-marker.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { type FakeWorkspace, fakeHerdr } from "../helpers/fake-herdr.js";

/** `aw hubs sync --herdr` over a fake Herdr 0.9.0 (plan 089 F2). */

const roots: string[] = [];
const allArgv: string[][] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(names: string[]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aw-hubs-sync-herdr-")));
  roots.push(root);
  const home = join(root, "home");
  mkdirSync(join(home, ".workflow"), { recursive: true });
  const hubs = names.map((name) => {
    const path = join(root, name);
    mkdirSync(join(path, ".workflow", "sessions"), { recursive: true });
    writeFileSync(join(path, ".workflow", "workline.json"), worklineMarkerContent("workflow"));
    return path;
  });
  writeFileSync(join(home, ".workflow", "hubs.json"), JSON.stringify({ version: 1, roots: hubs }));
  return { root, home, hubs };
}

function healthy(root: string, pending: number, next: string | null): HubStatus {
  return { name: root, root, ok: true, pending, next, notices: 0, last_activity: null };
}

function sync(
  home: string,
  herdr: ReturnType<typeof fakeHerdr>,
  status: HubStatus[],
  options: { ide?: boolean; dryRun?: boolean } = {},
) {
  return runHubsSync(
    {
      fs: new NodeFileSystem(),
      home,
      namespace: "workflow",
      tempRoots: [],
      herdr: {
        cli: new HerdrCli(herdr.process),
        status: async () => ({ hubs: status, counts: { hubs: 0, ok: 0, pending: 0, notices: 0 } }),
      },
    },
    { ide: options.ide ?? false, herdr: true, dryRun: options.dryRun ?? false },
  ).finally(() => allArgv.push(...herdr.herdrCalls()));
}

const verbs = (calls: string[][]) => calls.map((args) => args.slice(0, 2).join(" "));

describe("aw hubs sync --herdr", () => {
  it("confirma por el cwd de un panel el workspace existente y sólo publica su estado", async () => {
    const { home, hubs } = fixture(["alfa"]);
    const alfa = hubs[0] ?? "";
    const herdr = fakeHerdr([
      {
        workspace_id: "w1",
        label: "hub:alfa",
        panes: [{ cwd: "/elsewhere", foreground_cwd: join(alfa, "src") }],
      },
    ]);
    const out = await sync(home, herdr, [
      healthy(alfa, 2, "/w:plan-exec docs/plans/001-plan-x.md"),
    ]);
    expect(out.herdr).toEqual({
      degradation: null,
      hubs: [
        { name: "alfa", root: alfa, action: "unchanged", workspace_id: "w1", published: true },
      ],
    });
    expect(verbs(herdr.herdrCalls())).not.toContain("workspace create");
    expect(herdr.herdrCalls().at(-1)).toEqual(
      expect.arrayContaining([
        "report-metadata",
        "w1",
        "pending=2",
        "next=/w:plan-exec docs/plans/001-plan-x.md",
      ]),
    );
  });

  it("crea el workspace que falta una sola vez: el segundo sync lo encuentra", async () => {
    const { home, hubs } = fixture(["beta"]);
    const beta = hubs[0] ?? "";
    const state: FakeWorkspace[] = [];
    const first = fakeHerdr(state);
    expect((await sync(home, first, [healthy(beta, 0, null)])).herdr?.hubs[0]).toMatchObject({
      action: "created",
      workspace_id: "wnew1",
      published: true,
    });
    expect(first.herdrCalls()).toContainEqual([
      "workspace",
      "create",
      "--cwd",
      beta,
      "--label",
      "hub:beta",
      "--no-focus",
    ]);
    const second = fakeHerdr(state);
    expect((await sync(home, second, [healthy(beta, 0, null)])).herdr?.hubs[0]).toMatchObject({
      action: "unchanged",
      workspace_id: "wnew1",
    });
    expect(verbs(second.herdrCalls())).not.toContain("workspace create");
    expect(state).toHaveLength(1);
  });

  it("un label sin panel en el hub y un label repetido quedan en conflict, sin tocarse", async () => {
    const { home, hubs } = fixture(["gamma", "delta"]);
    const [gamma = "", delta = ""] = hubs;
    const herdr = fakeHerdr([
      {
        workspace_id: "w1",
        label: "hub:gamma",
        panes: [{ cwd: "/somewhere/else", foreground_cwd: "/tmp" }],
      },
      { workspace_id: "w2", label: "hub:delta", panes: [{ cwd: delta, foreground_cwd: delta }] },
      { workspace_id: "w3", label: "hub:delta", panes: [{ cwd: delta, foreground_cwd: delta }] },
    ]);
    const out = await sync(home, herdr, [healthy(gamma, 1, null), healthy(delta, 1, null)]);
    expect(out.herdr?.hubs).toEqual([
      {
        name: "gamma",
        root: gamma,
        action: "conflict",
        workspace_id: "w1",
        published: false,
        reason: "ningún panel en el hub",
      },
      {
        name: "delta",
        root: delta,
        action: "conflict",
        published: false,
        reason: "2 workspaces con hub:delta",
      },
    ]);
    expect(
      verbs(herdr.herdrCalls()).filter((verb) => verb !== "workspace list" && verb !== "pane list"),
    ).toEqual(["--version"]);
  });

  it("un hub ilegible para el estado se salta sin publicar, y --dry-run sólo lee", async () => {
    const { home, hubs } = fixture(["epsilon", "zeta"]);
    const [epsilon = "", zeta = ""] = hubs;
    const herdr = fakeHerdr([
      { workspace_id: "w1", label: "hub:zeta", panes: [{ cwd: zeta, foreground_cwd: zeta }] },
    ]);
    const unreadable: HubStatus = {
      name: "epsilon",
      root: epsilon,
      ok: false,
      reason: "unreadable",
    };
    const out = await sync(home, herdr, [unreadable, healthy(zeta, 4, null)], { dryRun: true });
    expect(out.herdr?.hubs).toEqual([
      { name: "epsilon", root: epsilon, action: "skipped", published: false, reason: "unreadable" },
      { name: "zeta", root: zeta, action: "unchanged", workspace_id: "w1", published: false },
    ]);
    expect(verbs(herdr.herdrCalls())).toEqual(["--version", "workspace list", "pane list"]);

    const missing = await sync(home, fakeHerdr([]), [healthy(zeta, 4, null)], { dryRun: true });
    expect(missing.herdr?.hubs.find((hub) => hub.root === zeta)).toEqual({
      name: "zeta",
      root: zeta,
      action: "created",
      published: false,
    });
  });

  it.each([
    ["missing", { which: undefined }],
    ["unsupported-version", { version: "1.0.0" }],
    [
      "unreachable",
      {
        run: (args: string[]) =>
          args[0] === "workspace" ? { code: 1, stdout: "", stderr: "socket closed" } : undefined,
      },
    ],
    [
      "cli-changed",
      {
        run: (args: string[]) =>
          args[0] === "workspace" ? { code: 0, stdout: "[]", stderr: "" } : undefined,
      },
    ],
  ] as const)("%s se declara, no lanza, y --ide escribe igual", async (kind, overrides) => {
    const { home, hubs } = fixture(["eta"]);
    const eta = hubs[0] ?? "";
    const herdr = fakeHerdr([], overrides);
    const out = await sync(home, herdr, [healthy(eta, 0, null)], { ide: true });
    expect(out.herdr).toMatchObject({ degradation: { kind }, hubs: [] });
    expect(out.ide?.hubs[0]).toMatchObject({ action: "created" });
    expect(existsSync(join(eta, "eta.code-workspace"))).toBe(true);
    expect(verbs(herdr.herdrCalls())).not.toContain("workspace create");
  });

  it("una degradación a mitad de camino detiene las llamadas siguientes", async () => {
    const { home, hubs } = fixture(["theta", "iota"]);
    const [theta = "", iota = ""] = hubs;
    const herdr = fakeHerdr([], {
      run: (args) =>
        args[1] === "create" ? { code: 1, stdout: "", stderr: "server gone" } : undefined,
    });
    const out = await sync(home, herdr, [healthy(theta, 0, null), healthy(iota, 0, null)]);
    expect(out.herdr?.degradation).toEqual({
      kind: "unreachable",
      detail: "workspace create: server gone",
    });
    expect(out.herdr?.hubs.map((hub) => [hub.action, hub.reason])).toEqual([
      ["skipped", "herdr unreachable"],
      ["skipped", "herdr unreachable"],
    ]);
    expect(verbs(herdr.herdrCalls()).filter((verb) => verb === "workspace create")).toHaveLength(1);
  });

  it("ningún argv emitido cierra ni renombra", () => {
    expect(allArgv.length).toBeGreaterThan(0);
    for (const args of allArgv) {
      expect(args).not.toContain("close");
      expect(args).not.toContain("rename");
    }
  });

  it("aw hubs status no llama a Herdr", async () => {
    const { home } = fixture(["kappa"]);
    const herdr = fakeHerdr([]);
    const fs = new NodeFileSystem();
    const ctx = {
      fs,
      rawFs: fs,
      env: new FakeEnv(home, home),
      paths: { namespace: "workflow" },
      process: herdr.process,
    } as unknown as CliContext;
    const result = await hubsCommand.execute(parseArgv(["hubs", "status"]), ctx);
    expect(result.data).toMatchObject({ action: "status", counts: { hubs: 1 } });
    expect(herdr.process.calls).toEqual([]);
  });

  it("un cwd de panel ilegible o relativo no confirma nada ni lanza", async () => {
    const { root, home, hubs } = fixture(["lambda", "mu"]);
    const [lambda = "", mu = ""] = hubs;
    writeFileSync(join(root, "a-file"), "x");
    const herdr = fakeHerdr([
      {
        workspace_id: "w1",
        label: "hub:lambda",
        panes: [{ cwd: join(root, "a-file", "below"), foreground_cwd: join(root, "a-file", "x") }],
      },
      {
        workspace_id: "w2",
        label: "hub:mu",
        panes: [{ cwd: relative(process.cwd(), mu), foreground_cwd: "" }],
      },
    ]);
    const out = await sync(home, herdr, [healthy(lambda, 0, null), healthy(mu, 0, null)]);
    expect(out.herdr?.hubs.map((hub) => [hub.name, hub.action])).toEqual([
      ["lambda", "conflict"],
      ["mu", "conflict"],
    ]);
  });

  it("dos hubs con el mismo nombre no crean dos workspaces con un mismo label", async () => {
    const { root, home } = fixture([]);
    const one = join(root, "a", "x", "nu");
    const two = join(root, "b", "x", "nu");
    for (const path of [one, two]) {
      mkdirSync(join(path, ".workflow", "sessions"), { recursive: true });
      writeFileSync(join(path, ".workflow", "workline.json"), worklineMarkerContent("workflow"));
    }
    writeFileSync(
      join(home, ".workflow", "hubs.json"),
      JSON.stringify({ version: 1, roots: [one, two] }),
    );
    const herdr = fakeHerdr([]);
    const out = await sync(home, herdr, [healthy(one, 0, null), healthy(two, 0, null)]);
    expect(out.herdr?.hubs.map((hub) => [hub.action, hub.reason])).toEqual([
      ["created", undefined],
      ["skipped", "nombre repetido: hub:x/nu"],
    ]);
    expect(verbs(herdr.herdrCalls()).filter((verb) => verb === "workspace create")).toHaveLength(1);
  });

  it("un homónimo en conflict no le quita el label al hub que sí tiene su workspace", async () => {
    const { root, home } = fixture([]);
    const one = join(root, "a", "x", "xi");
    const two = join(root, "b", "x", "xi");
    for (const path of [one, two]) {
      mkdirSync(join(path, ".workflow", "sessions"), { recursive: true });
      writeFileSync(join(path, ".workflow", "workline.json"), worklineMarkerContent("workflow"));
    }
    writeFileSync(
      join(home, ".workflow", "hubs.json"),
      JSON.stringify({ version: 1, roots: [one, two] }),
    );
    const herdr = fakeHerdr([
      { workspace_id: "w9", label: "hub:x/xi", panes: [{ cwd: two, foreground_cwd: two }] },
    ]);
    const out = await sync(home, herdr, [healthy(one, 0, null), healthy(two, 1, null)]);
    expect(out.herdr?.hubs.map((hub) => [hub.action, hub.workspace_id, hub.published])).toEqual([
      ["conflict", "w9", false],
      ["unchanged", "w9", true],
    ]);
  });
});
