import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DoctorRunOptions } from "../../src/application/doctor/report.js";
import { parseArgv } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
import type { DoctorReport } from "../../src/domain/doctor/model.js";

/**
 * El cableado entre el flag que la persona tipea y la autorización que llega
 * adentro.
 *
 * Existe porque su ausencia era un hueco real: `--verify-connection` es la única
 * autorización de red de todo el comando, y desconectarlo del `options` que se
 * pasa hacia adentro dejaba las 4681 pruebas del repositorio en verde. Las
 * pruebas de la maquinaria llaman a `runDoctor` con la opción ya puesta, así que
 * ninguna miraba el tramo que va del `argv` a esa opción — que es justamente el
 * tramo donde un flag se pierde en silencio.
 *
 * `runDoctor` se dobla porque la superficie no acepta proveedores inyectados: sin
 * el doble, esta prueba diagnosticaría la máquina de quien corra la suite y,
 * peor, con `--verify-connection` intentaría conectarse a sus bases.
 */
const seen = vi.hoisted(() => ({ options: [] as DoctorRunOptions[] }));

vi.mock("../../src/application/doctor/report.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/application/doctor/report.js")>();
  return {
    ...actual,
    runDoctor: async (_ctx: CliContext, options: DoctorRunOptions = {}): Promise<DoctorReport> => {
      seen.options.push(options);
      return {
        schema_version: 1,
        cli_version: "0.0.0-test",
        scope: { workspace_dir: "/ws", current_host: null, only: [] },
        hosts: [],
        hosts_absent: [],
        coverage: [],
        findings: [],
        summary: { healthy: 0, warning: 0, blocking: 0, unverified: 0, actionable: 0 },
        verdict: { exit_code: 0, reason: "sin hallazgos" },
      };
    },
  };
});

const { doctorCommand } = await import("../../src/cli/commands/doctor.js");

const ctx = { paths: { workspaceDir: () => "/ws" } } as unknown as CliContext;

beforeEach(() => {
  seen.options.length = 0;
});

describe("aw doctor · la autorización de red viaja del argv hacia adentro", () => {
  it("sin el flag NADIE pide verificar", async () => {
    await doctorCommand.execute(parseArgv(["doctor"]), ctx);

    expect(seen.options).toHaveLength(1);
    expect(seen.options[0]?.verify).toBeUndefined();
  });

  it("con `--verify-connection` la clase de red llega como autorización", async () => {
    // El defecto que atrapa: el flag se puede desconectar del `options` y nada
    // más en el repositorio lo nota, porque las pruebas de la maquinaria pasan la
    // opción ya puesta.
    await doctorCommand.execute(parseArgv(["doctor", "--verify-connection"]), ctx);

    expect(seen.options[0]?.verify).toEqual(["network_external"]);
  });

  it("el flag es booleano: `aw doctor --verify-connection prepare` prepara, no informa", () => {
    // Sin declararlo en el parser, `consumeOptionFlag` toma el token siguiente
    // como su valor y el subverbo desaparece.
    const parsed = parseArgv(["doctor", "--verify-connection", "prepare"]);

    expect(parsed.flags.has("--verify-connection")).toBe(true);
    expect(parsed.rest).toEqual(["prepare"]);
    expect(parsed.values.has("verify-connection")).toBe(false);
  });

  it("la autorización atraviesa los subverbos, no sólo el informe", async () => {
    // `prepare` y `apply` recomputan el informe, así que si el flag no las
    // atravesara la misma invocación observaría dos cosas distintas del mismo
    // recurso — y el digest de una no valdría para la otra.
    await doctorCommand.execute(parseArgv(["doctor", "prepare", "--verify-connection"]), ctx);

    expect(seen.options.length).toBeGreaterThanOrEqual(1);
    for (const options of seen.options) expect(options.verify).toEqual(["network_external"]);
  });
});
