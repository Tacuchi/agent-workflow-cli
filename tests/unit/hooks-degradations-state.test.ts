// Las degradaciones declaradas de un host tienen que verse en el ESTADO, no sólo
// en el output de la instalación.
//
// `armed: true` a secas exagera el caso en un host que expresa sólo parte del
// conjunto: dice "los hooks están" mientras uno de ellos, en silencio, no está.
// El estado carga por eso las mismas degradaciones que reporta el install, y de
// la MISMA transformación — dos textos acabarían discrepando.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PathsService } from "../../src/application/paths-service.js";
import {
  reportHookTemplateLosses,
  reportHooksArmed,
} from "../../src/application/self/host-states.js";
import { HOOKS_MANAGED_TARGETS } from "../../src/application/self/install-targets.js";
import type { CliContext } from "../../src/cli/types.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import type { ResolvedRuntime } from "../../src/runtime/types.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { FakeProcess } from "../helpers/fake-process.js";
import { NoScanFs as RealFs } from "../helpers/real-fs.js";

function buildCtx(home: string): CliContext {
  const ns = normalizeNamespace("agent-workflow");
  const runtime: ResolvedRuntime = {
    packageName: "@tacuchi/agent-workflow-cli",
    binName: "agent-workflow",
    source: "default",
  };
  return {
    fs: new RealFs(),
    env: new FakeEnv(home),
    process: new FakeProcess(),
    git: {} as never,
    namespace: { namespace: ns, source: "default" },
    runtime,
    paths: new PathsService(ns, home, home),
  };
}

describe("reportHooksArmed — el estado declara lo que el host no puede cargar", () => {
  let workdir: string;
  let home: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "aw-hooks-state-"));
    home = join(workdir, "home");
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it("informa una fila por host gestionado, nunca un booleano global", async () => {
    const reports = await reportHooksArmed(buildCtx(home));
    expect(reports.map((r) => r.target).sort()).toEqual([...HOOKS_MANAGED_TARGETS].sort());
  });

  it("kimi declara sus dos pérdidas reales de la plantilla instalada", async () => {
    const reports = await reportHookTemplateLosses(buildCtx(home));
    const kimi = reports.find((r) => r.target === "kimi");
    expect(kimi).toBeDefined();
    // La plantilla del bundle se leyó de verdad: si no, la lista vacía sería
    // "no sé" y no "no pierde nada", y esa diferencia es la que este campo fija.
    expect(kimi?.template_read).toBe(true);
    const declared = (kimi?.losses ?? []).join(" | ");
    // 1) el hook `type: "prompt"` de PostCompact no tiene comando: se omite.
    expect(declared).toMatch(/PostCompact/);
    expect(declared).toMatch(/prompt/);
    // 2) el matcher de SessionStart no viaja: el hook queda sin matcher.
    expect(declared).toMatch(/SessionStart/);
    expect(declared).toMatch(/matcher/);
  });

  it("claude no declara ninguna: mergea la plantilla entera y no pierde nada", async () => {
    const reports = await reportHookTemplateLosses(buildCtx(home));
    const claude = reports.find((r) => r.target === "claude");
    expect(claude).toBeDefined();
    expect(claude?.template_read).toBe(true);
    expect(claude?.losses).toEqual([]);
  });

  it("sin config del host, `armed` es false y las degradaciones se declaran igual", async () => {
    // Una degradación es una propiedad del host y de la plantilla, no del archivo:
    // es verdad ANTES de instalar, y esconderla hasta entonces es cómo alguien se
    // entera por sorpresa.
    const armed = await reportHooksArmed(buildCtx(home));
    for (const report of armed) {
      expect(report.armed, report.target).toBe(false);
    }
    const losses = await reportHookTemplateLosses(buildCtx(home));
    expect(losses.find((r) => r.target === "kimi")?.losses.length).toBeGreaterThan(0);
  });
});
