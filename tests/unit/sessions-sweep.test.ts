import { describe, expect, it } from "vitest";
import { writeRefugeCheckpoint } from "../../src/application/checkpoint-write-service.js";
import { PathsService } from "../../src/application/paths-service.js";
import { runSessionsSweep } from "../../src/application/sessions-sweep-service.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeProcess } from "../helpers/fake-process.js";
import { MemFs } from "../helpers/mem-fs.js";

const paths = new PathsService(normalizeNamespace("workflow"), "/home", "/cwd");

describe("aw sessions --sweep", () => {
  it("lista cinco residuos, los barre con apply y respeta los de sesión activa o pausada", async () => {
    const fs = new MemFs({ lenient: true });
    const sessions = paths.cwdSessionsDir();
    fs.file(`${sessions}/001-activa-quick/SESSION.md`, "# SESSION\n");
    fs.file(`${sessions}/001-activa-quick/.flow-run.json.lock`, "activo");
    fs.file(`${sessions}/002-cerrada-quick/SESSION.md`, "# SESSION\n");
    fs.file(`${sessions}/002-cerrada-quick/.closed`, "");
    fs.file(`${sessions}/002-cerrada-quick/.flow-run.json.lock`, "cerrado");
    fs.file(`${sessions}/003-pausada-quick/SESSION.md`, "# SESSION\n");
    fs.file(`${sessions}/003-pausada-quick/.paused`, "");
    fs.file(paths.cwdFlowAttemptsFile("001-activa-quick"), "activo");
    fs.file(paths.cwdFlowAttemptsFile("002-cerrada-quick"), "cerrado");
    fs.file(paths.cwdFlowAttemptsFile("004-ausente-quick"), "ausente");
    fs.file(paths.cwdFlowAttemptsFile("003-pausada-quick"), "pausado");
    fs.file(
      paths.cwdSessionBindingsFile(),
      JSON.stringify({
        version: 1,
        bindings: { vigente: "001-activa-quick", colgante: "004-ausente-quick" },
      }),
    );
    fs.file(
      paths.cwdProcessesFile(),
      JSON.stringify([
        { id: "p-exited", state: "exited" },
        { id: "p-running", state: "running" },
      ]),
    );
    await writeRefugeCheckpoint(fs, paths, {
      reason: "sin adoptar",
      action: "barre",
      now: new Date("2025-01-01"),
      candidates: [{ folder: "002-cerrada-quick", code: "002", state: "closed" }],
    });

    const process = new FakeProcess();
    const preview = await runSessionsSweep(fs, paths, false, process);
    if ("error" in preview) throw new Error(preview.error);
    expect(preview).toMatchObject({
      applied: false,
      processes: ["p-exited"],
      bindings: ["004-ausente-quick"],
    });
    expect(preview.locks).toEqual([".workflow/sessions/002-cerrada-quick/.flow-run.json.lock"]);
    expect(preview.attempts).toHaveLength(2);
    expect(preview.refuges).toHaveLength(1);
    expect(await fs.exists(`${sessions}/002-cerrada-quick/.flow-run.json.lock`)).toBe(true);
    expect(await runSessionsSweep(fs, paths, true)).toHaveProperty("error");
    expect(await fs.exists(`${sessions}/002-cerrada-quick/.flow-run.json.lock`)).toBe(true);

    const swept = await runSessionsSweep(fs, paths, true, process);
    if ("error" in swept) throw new Error(swept.error);
    expect(swept.applied).toBe(true);
    expect(await fs.exists(`${sessions}/001-activa-quick/.flow-run.json.lock`)).toBe(true);
    expect(await fs.exists(paths.cwdFlowAttemptsFile("003-pausada-quick"))).toBe(true);
    expect(await fs.exists(`${sessions}/002-cerrada-quick/.flow-run.json.lock`)).toBe(false);
    expect(
      JSON.parse(await fs.readText(paths.cwdProcessesFile())).map((row: { id: string }) => row.id),
    ).toEqual(["p-running"]);
    const again = await runSessionsSweep(fs, paths, false, process);
    if ("error" in again) throw new Error(again.error);
    expect([again.locks, again.attempts, again.processes, again.bindings, again.refuges]).toEqual([
      [],
      [],
      [],
      [],
      [],
    ]);
  });
});
