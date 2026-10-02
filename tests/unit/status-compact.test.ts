import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runHubsStatus } from "../../src/application/hubs-status-service.js";
import { runStatusCommand } from "../../src/application/status-service.js";
import { statusCommand, statusNotices } from "../../src/cli/commands/status.js";
import { parseArgv } from "../../src/cli/parser.js";
import { renderRaw } from "../../src/cli/render.js";
import { FakeEnv } from "../helpers/fake-env.js";
import {
  LARGE_HUB_CLOSED_PLANS,
  LARGE_HUB_OPEN_PLAN,
  addClosedPlans,
  largeHub,
  largeHubContext,
  largeHubPaths,
} from "../helpers/large-hub-fixture.js";
import type { MemFs } from "../helpers/mem-fs.js";

const NOW = new Date(2026, 5, 21, 15, 0, 0);

async function status(fs: MemFs, ...argv: string[]) {
  return statusCommand.execute(parseArgv(["status", ...argv]), largeHubContext(fs));
}

/** The bytes `aw status --json [--detail]` writes for this result. */
function json(result: Awaited<ReturnType<typeof status>>, detail = false): string {
  const data = result.data;
  if (data === undefined) throw new Error("esperaba datos");
  return renderRaw(statusCommand.projectJson?.(data, { detail }) ?? data);
}

function human(result: Awaited<ReturnType<typeof status>>, detail = false): string {
  return statusCommand.renderHuman?.(result, { detail }) ?? "";
}

describe("aw status por defecto — sólo lo pendiente, en humano y en JSON", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("el JSON por defecto trae hub, last_activity, pipeline, avisos y counts, sin colecciones vacías", async () => {
    const fs = largeHub();
    const body = JSON.parse(json(await status(fs)));
    expect(Object.keys(body).sort()).toEqual(["counts", "hub", "last_activity", "pipeline"]);
    expect(body.pipeline.map((item: { number: string }) => item.number)).toContain(
      LARGE_HUB_OPEN_PLAN,
    );
    expect(body.counts.plans).toBe(LARGE_HUB_CLOSED_PLANS + 1);
  });

  it("sin pendientes, el pipeline se omite y counts va igual", async () => {
    const fs = largeHub();
    await fs.remove(`/cwd/docs/plans/${LARGE_HUB_OPEN_PLAN}-plan-abierto.md`);
    await fs.remove("/cwd/docs/specs/090-spec-borrador.md");
    await fs.remove("/cwd/docs/specs/091-spec-lista.md");
    const body = JSON.parse(json(await status(fs)));
    expect(Object.keys(body).sort()).toEqual(["counts", "hub", "last_activity"]);
    expect(body.counts.pending).toBe(0);
    expect(human(await status(fs))).toContain("— sin pendientes");
  });

  it("los avisos son los mismos en humano y en JSON, cada uno con kind, message y next", async () => {
    const fs = largeHub();
    fs.file(
      "/cwd/.workflow/sessions/200-apartada-quick/SESSION.md",
      "# SESSION — apartada\n\n## Objective\nEsperar\n\n## Type\nquick\n",
      new Date(2026, 0, 10, 9, 0, 0),
    );
    fs.file("/cwd/.workflow/sessions/200-apartada-quick/.paused", "", new Date(2026, 0, 10));
    const result = await status(fs);
    const body = JSON.parse(json(result));
    expect(body.notices).toEqual(statusNotices(await full(fs)));
    expect(body.notices.length).toBeGreaterThan(0);
    const text = human(result);
    for (const notice of body.notices) {
      expect(Object.keys(notice).sort()).toEqual(["kind", "message", "next"]);
      expect(text).toContain(notice.message);
      expect(text).toContain(`→ ${notice.next}`);
    }
  });

  it("sumar 100 planes cerrados no cambia los bytes de la vista humana ni el tamaño del JSON", async () => {
    const fs = largeHub();
    const before = await status(fs);
    addClosedPlans(fs, 100 + LARGE_HUB_CLOSED_PLANS, 100);
    const after = await status(fs);
    expect(human(after)).toBe(human(before));
    // The counts are the one thing that grows, and they keep their width.
    const [was, now] = [JSON.parse(json(before)), JSON.parse(json(after))];
    expect(now.counts.plans).toBe(was.counts.plans + 100);
    expect(json(after).length).toBe(json(before).length);
    expect({ ...now, counts: undefined }).toEqual({ ...was, counts: undefined });
  });

  it("--detail trae el inventario completo, y --plan sale igual que sin la proyección", async () => {
    const fs = largeHub();
    expect(JSON.parse(json(await status(fs), true))).toEqual(
      JSON.parse(JSON.stringify(await full(fs))),
    );
    expect(human(await status(fs), true)).toContain("Terminado: ");
    const plan = await status(fs, "--plan", LARGE_HUB_OPEN_PLAN);
    expect(json(plan)).toBe(renderRaw(plan.data));
  });
});

async function full(fs: MemFs) {
  return runStatusCommand(fs, new FakeEnv("/home", "/cwd"), largeHubPaths());
}

describe("aw hubs status — el tamaño sigue a los hubs, no a su historia (plan 088 F3)", () => {
  let home: string;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    home = mkdtempSync(join(tmpdir(), "aw-hubs-size-"));
    mkdirSync(join(home, ".workflow"));
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(home, { recursive: true, force: true });
  });

  function register(...roots: string[]) {
    writeFileSync(join(home, ".workflow", "hubs.json"), JSON.stringify({ version: 1, roots }));
  }

  async function hubsJson(fs: MemFs): Promise<string> {
    const data = await runHubsStatus(
      { fs, env: new FakeEnv(home, "/cwd") },
      "workflow",
      (board) => statusNotices(board).length,
    );
    return JSON.stringify(data);
  }

  it("100 planes cerrados más dejan los bytes iguales y un hub más suma exactamente su objeto", async () => {
    const fs = largeHub();
    fs.file("/cwd/.workflow/workline.json", '{"workline":1}');
    register("/cwd");
    const before = await hubsJson(fs);
    const [hub] = JSON.parse(before).hubs;
    expect(hub).toMatchObject({ name: "cwd", root: "/cwd", ok: true });
    expect(JSON.stringify(hub).length).toBeLessThanOrEqual(200);

    addClosedPlans(fs, 100 + LARGE_HUB_CLOSED_PLANS, 100);
    expect(await hubsJson(fs)).toBe(before);

    fs.file("/otro/.workflow/workline.json", '{"workline":1}');
    register("/cwd", "/otro");
    const after = await hubsJson(fs);
    const added = JSON.parse(after).hubs[1];
    expect(added).toEqual({
      name: "otro",
      root: "/otro",
      ok: true,
      pending: 0,
      next: null,
      notices: 0,
      last_activity: null,
    });
    expect(after.length - before.length).toBe(JSON.stringify(added).length + 1);
  });
});
