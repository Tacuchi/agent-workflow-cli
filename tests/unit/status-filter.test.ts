import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runStatusCommand } from "../../src/application/status-service.js";
import { statusCommand } from "../../src/cli/commands/status.js";
import { parseArgv } from "../../src/cli/parser.js";
import { FakeEnv } from "../helpers/fake-env.js";
import {
  LARGE_HUB_CLOSED_PLANS,
  LARGE_HUB_OPEN_PLAN,
  LARGE_HUB_UNPLANNED_SPEC,
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

function human(result: Awaited<ReturnType<typeof status>>): string {
  return statusCommand.renderHuman?.(result, { detail: false }) ?? "";
}

describe("aw status --plan / --spec — un solo documento", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("--plan y --spec traen exactamente el ítem del modelo completo, más hub y last_activity", async () => {
    const fs = largeHub();
    const full = await runStatusCommand(fs, new FakeEnv("/home", "/cwd"), largeHubPaths());
    const plan = await status(fs, "--plan", LARGE_HUB_OPEN_PLAN);
    expect(plan.ok).toBe(true);
    expect(Object.keys(plan.data ?? {}).sort()).toEqual(["hub", "last_activity", "plan"]);
    expect(plan.data).toEqual({
      hub: full.hub,
      last_activity: full.last_activity,
      plan: full.plans.find((item) => item.number === LARGE_HUB_OPEN_PLAN),
    });
    const spec = await status(fs, "--spec", LARGE_HUB_UNPLANNED_SPEC);
    expect(Object.keys(spec.data ?? {}).sort()).toEqual(["hub", "last_activity", "spec"]);
    expect(spec.data).toEqual({
      hub: full.hub,
      last_activity: full.last_activity,
      spec: full.specs.find((item) => item.number === LARGE_HUB_UNPLANNED_SPEC),
    });
  });

  it("el número se compara por valor", async () => {
    const fs = largeHub();
    const padded = await status(fs, "--plan", LARGE_HUB_OPEN_PLAN);
    const bare = await status(fs, "--plan", String(Number(LARGE_HUB_OPEN_PLAN)));
    expect(bare.data).toEqual(padded.data);
  });

  it("la vista humana es un bloque con estado, avance, fases bloqueadas y lo que debe", async () => {
    const text = human(await status(largeHub(), "--plan", LARGE_HUB_OPEN_PLAN));
    expect(text).toContain(`plan ${LARGE_HUB_OPEN_PLAN} — abierto`);
    expect(text).toContain("estado: open · tareas 1/2 · fases 1/2");
    expect(text).toContain("bloqueada F2 — pendiente: falta la fixture");
    expect(text).not.toContain("cerrado-");
  });

  it("un número sin documento sale con exit 1 y lo nombra; nunca un resultado vacío", async () => {
    const missing = await status(largeHub(), "--plan", "999");
    expect(missing.ok).toBe(false);
    expect(missing.exitCode).toBe(1);
    expect(missing.error?.code).toBe("STATUS_DOCUMENT_NOT_FOUND");
    expect(missing.error?.message).toContain("plan con número '999'");
    expect(missing.data).toBeUndefined();
    const spec = await status(largeHub(), "--spec", "999");
    expect(spec.error?.message).toContain("spec con número '999'");
  });

  it("--plan y --spec juntos se rechazan", async () => {
    const both = await status(largeHub(), "--plan", LARGE_HUB_OPEN_PLAN, "--spec", "091");
    expect(both.ok).toBe(false);
    expect(both.exitCode).toBe(1);
    expect(both.error?.code).toBe("STATUS_FILTER_CONFLICT");
  });

  it("sumar 100 planes cerrados no cambia los bytes de --plan, humano ni JSON", async () => {
    const fs = largeHub();
    const before = await status(fs, "--plan", LARGE_HUB_OPEN_PLAN);
    addClosedPlans(fs, 100 + LARGE_HUB_CLOSED_PLANS, 100);
    const full = await runStatusCommand(fs, new FakeEnv("/home", "/cwd"), largeHubPaths());
    expect(full.plans.length).toBe(LARGE_HUB_CLOSED_PLANS + 100 + 1);
    const after = await status(fs, "--plan", LARGE_HUB_OPEN_PLAN);
    expect(JSON.stringify(after.data)).toBe(JSON.stringify(before.data));
    expect(human(after)).toBe(human(before));
  });
});
