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
 * A colliding correlation is readable by exact folder but never writable.
 *
 * The resolver used to let a flow mutate one of two durable records sharing
 * `047`. The v22 rule stops the write before its first state file and names the
 * workspace migration/rename that restores a unique record key.
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
    const ambiguous = await resolveSessionTarget(fs, paths, { code: BARE, intent: "read" });
    expect(ambiguous.outcome).toBe("error");
    if (ambiguous.outcome !== "error") return;
    expect(ambiguous.code).toBe("SESSION_AMBIGUOUS");
  });

  it("una directiva que escribiría sobre la colisión deriva primero a migración", async () => {
    // `advanceFlow` muta el estado durable de la corrida. Aunque se le nombre
    // una carpeta exacta, el nuevo contrato no permite elegir una fila HISTORY
    // mientras la serie comparte correlativo; una lectura sí puede resolverla.
    const attempted = await advanceFlow(fs, paths, {
      code: SESSION,
      flow: "spec-refine",
      adopt: true,
    });
    expect(attempted.ok).toBe(false);
    if (attempted.ok) return;
    if (!("session" in attempted)) throw new Error("expected a session resolution refusal");
    expect(attempted.session.code).toBe("SESSION_AMBIGUOUS");
    expect(attempted.session.action).toContain("workspace-migrate");
    expect(attempted.session.action).toContain("renombrá");
  });
});
