import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { advanceFlow } from "../../src/application/flow/flow-service.js";
import { PathsService } from "../../src/application/paths-service.js";
import { resolveSessionTarget } from "../../src/application/session-resolver.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { NodeFileSystem } from "../helpers/real-fs.js";

/**
 * La directiva que el motor emite tiene que ser EJECUTABLE TAL CUAL.
 *
 * El defecto que esto fija: la invocación se sellaba con el número desnudo de la
 * sesión (`--code 047`), que en un workspace con una carpeta legacy homónima
 * casa con DOS sesiones. Ejecutar la propia directiva fallaba por ambigüedad, y
 * corregirla a mano la convertía en otra invocación que el `submit` rechazaba
 * por discrepancia — la directiva del propio CLI era insatisfacible, y a los
 * tres intentos la frontera quedaba agotada sin salida.
 *
 * La prueba no mira el string: toma el `--code` que la directiva emitió y lo
 * pasa por el resolvedor real, que es quien lo va a resolver en producción.
 */

const fs = new NodeFileSystem();

const SESSION = "047-identidad-spec-refine";
const LEGACY = "session047-vieja";
const BARE = "047";

describe("la identidad que emite una directiva resuelve a una sola sesión", () => {
  let workdir: string;
  let paths: PathsService;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "aw-directive-identity-"));
    paths = new PathsService(normalizeNamespace("agent-workflow"), workdir, workdir);
    for (const folder of [SESSION, LEGACY]) {
      await mkdir(join(paths.cwdSessionsDir(), folder), { recursive: true });
      await writeFile(
        join(paths.cwdSessionsDir(), folder, "SESSION.md"),
        `# SESSION — ${folder}\n\n## Objective\nprobar la identidad\n`,
        "utf8",
      );
    }
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it("el fixture es genuinamente ambiguo: el número desnudo casa con dos sesiones", async () => {
    // Sin esto la prueba de abajo pasaría en un workspace donde nada podía
    // fallar, que es la forma más común de que una regresión no se note.
    const ambiguous = await resolveSessionTarget(fs, paths, { code: BARE });
    expect(ambiguous.outcome).toBe("error");
    if (ambiguous.outcome !== "error") return;
    expect(ambiguous.code).toBe("SESSION_AMBIGUOUS");
  });

  it("el `--code` de la directiva resuelve, ejecutado verbatim", async () => {
    // `spec-refine` delega ya en su primera frontera, así que la invocación
    // sellada se puede leer sin atravesar medio recorrido para llegar a ella.
    const adopted = await advanceFlow(fs, paths, {
      code: SESSION,
      flow: "spec-refine",
      adopt: true,
    });
    if (!adopted.ok) throw new Error("esperaba adoptar la corrida");

    const args = adopted.directive.action?.invocation.args;
    if (args === undefined) throw new Error("la primera frontera dejó de delegar su invocación");
    const emitted = args[args.indexOf("--code") + 1];
    expect(emitted).toBeDefined();

    const resolved = await resolveSessionTarget(fs, paths, { code: emitted as string });
    expect(resolved.outcome).toBe("resolved");
    if (resolved.outcome !== "resolved") return;
    expect(resolved.session.folder).toBe(SESSION);
  });
});
