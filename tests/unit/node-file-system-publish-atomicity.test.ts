import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { runNextNumber } from "../../src/application/dev-only-services.js";
import { PathsService } from "../../src/application/paths-service.js";
import { leadingCorrelative } from "../../src/domain/correlative.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";

/**
 * The one guarantee this whole change exists to create, pinned so a regression
 * cannot hide.
 *
 * The first version of these proofs asserted only END STATE — full content
 * present, EEXIST refused, no residue — and every one of them also held for the
 * non-atomic primitive it replaced. Swapping `publishTextExclusive`'s body for
 * `return this.writeTextExclusive(path, content)` left 36 targeted tests green.
 * A check that cannot fail proves nothing, so these two observe the MOMENT of
 * the commit instead of the state after it.
 */

/** What `link` saw at the instant it was called. */
interface LinkObservation {
  destinationExisted: boolean;
  stagedBytes: number;
}
const observations: LinkObservation[] = [];
/** When set, the staging write leaves a PARTIAL file and then fails, like ENOSPC. */
let stagingFailure: NodeJS.ErrnoException | null = null;

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: async (p: never, c: never, e: never) => {
      if (stagingFailure !== null) {
        // A real out-of-space leaves bytes behind: that is the entire hazard.
        await actual.writeFile(p, String(c).slice(0, 4) as never, e);
        throw stagingFailure;
      }
      return actual.writeFile(p, c, e);
    },
    link: async (existing: string, target: string) => {
      observations.push({
        destinationExisted: existsSync(target),
        stagedBytes: existsSync(existing) ? statSync(existing).size : -1,
      });
      return actual.link(existing, target);
    },
  };
});

const CONTENT = "---\nstatus: draft\n---\n\n# Spec de prueba\n";
const CONTENT_BYTES = Buffer.byteLength(CONTENT, "utf8");

describe("publishTextExclusive commits atomically", () => {
  let workspace: string;
  let fs: NodeFileSystem;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "publish-atomicity-"));
    fs = new NodeFileSystem();
    observations.length = 0;
    stagingFailure = null;
  });
  afterEach(() => rmSync(workspace, { recursive: true, force: true }));

  it("el destino no existe hasta que ya tiene TODOS sus bytes", async () => {
    const target = join(workspace, "001-spec-algo.md");

    expect(await fs.publishTextExclusive(target, CONTENT)).toEqual({ created: true });

    // Un solo commit, y en su instante el destino todavía no existía mientras el
    // staging ya estaba completo. Ésta es la aserción que el primitivo NO atómico
    // no puede pasar: nunca llama a link, así que no hay observación ninguna.
    expect(observations).toHaveLength(1);
    expect(observations[0]?.destinationExisted).toBe(false);
    expect(observations[0]?.stagedBytes).toBe(CONTENT_BYTES);
    expect(statSync(target).size).toBe(CONTENT_BYTES);
  });

  it("un fallo de staging no deja residuo ni consume el correlativo", async () => {
    const env = new FakeEnv(workspace, workspace);
    const paths = new PathsService(normalizeNamespace("workflow"), workspace, workspace);
    stagingFailure = Object.assign(new Error("ENOSPC simulado"), { code: "ENOSPC" });

    await expect(
      runNextNumber(fs, env, paths, {
        directory: "docs/specs",
        publish: { name: "spec-algo.md", content: CONTENT },
      }),
    ).rejects.toThrow(/ENOSPC/);

    // El residuo del staging no puede quedar, y sobre todo no puede LEERSE como
    // un correlativo: un temporal cuyo nombre empieza por `NNN-` quemaba el
    // número para siempre, invisible para heldReservation y para el cierre.
    const left = readdirSync(join(workspace, "docs", "specs"));
    expect(left.filter((n) => leadingCorrelative(n) !== null)).toEqual([]);

    stagingFailure = null;
    const after = await runNextNumber(fs, env, paths, { directory: "docs/specs" });
    expect(after.next).toBe("001");
  });
});
