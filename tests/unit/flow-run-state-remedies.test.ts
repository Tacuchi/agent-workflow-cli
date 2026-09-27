import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { advanceFlow, restartFlow } from "../../src/application/flow/flow-service.js";
import { locateRun, readRun } from "../../src/application/flow/run-state-service.js";
import { PathsService } from "../../src/application/paths-service.js";
import { semanticDigest } from "../../src/application/semantic-operation/protocol.js";
import { runSessionCreate } from "../../src/application/session-create-service.js";
import type { CapabilityFailure } from "../../src/domain/capability/protocol.js";
import {
  FLOW_RUN_STATE_VERSION,
  type FlowRunState,
  sealRunState,
  serializeRunState,
} from "../../src/domain/flow/run-state.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { NodeFileSystem } from "../helpers/real-fs.js";

/**
 * AC-10 of spec 052: every run-state refusal proposes a command that works in
 * that state — and `--adopt` only where it adopts.
 *
 * Not by reading the text alone: each case runs the command the refusal names
 * and checks that the run advances afterwards. A remedy that reads well and does
 * not work is the defect this file exists to catch.
 */

const fs = new NodeFileSystem();

describe("cada rechazo de estado propone un comando que funciona en su estado", () => {
  let workdir: string;
  let paths: PathsService;
  let session: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "aw-run-remedies-"));
    paths = new PathsService(normalizeNamespace("agent-workflow"), workdir, workdir);
    const created = await runSessionCreate(fs, paths, {
      type: "quick",
      name: "remedios-quick",
      objetivo: "probar los remedios",
    });
    if ("error" in created) throw new Error(`esperaba crear la sesión: ${created.error}`);
    session = created.sessionCreate.folder;
    const first = await advanceFlow(fs, paths, { code: session, adopt: false });
    if (!first.ok) throw new Error(`esperaba arrancar: ${JSON.stringify(first)}`);
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  const location = () => locateRun(paths, session);

  async function seated(): Promise<FlowRunState> {
    const read = await readRun(fs, location());
    if (!read.ok) throw new Error(read.failure.code);
    return read.state;
  }

  /** The refusal the next advance returns, which is what a person is looking at. */
  async function refusal(): Promise<CapabilityFailure> {
    const result = await advanceFlow(fs, paths, { code: session, adopt: false });
    if (result.ok || "session" in result) throw new Error("esperaba un rechazo de estado");
    return result.failure;
  }

  /** Run exactly the command the refusal names, and say whether it worked. */
  async function runRemedy(action: string): Promise<boolean> {
    const restart = /aw flow restart --session (\S+?)['\s:]/.exec(action);
    if (restart !== null) return (await restartFlow(fs, paths, { code: restart[1] as string })).ok;
    const adopt = /aw flow advance --session (\S+) --flow <flow> --adopt/.exec(action);
    if (adopt !== null) {
      return (
        await advanceFlow(fs, paths, { code: adopt[1] as string, flow: "quick", adopt: true })
      ).ok;
    }
    throw new Error(`el rechazo no nombra un comando que esta prueba sepa correr: ${action}`);
  }

  async function sealedWith(change: (state: Omit<FlowRunState, "digest">) => object) {
    const { digest: _seal, ...rest } = await seated();
    const next = change(rest);
    await writeFile(
      location().statePath,
      JSON.stringify({ ...next, digest: semanticDigest(next) }),
      "utf8",
    );
  }

  const CASES: readonly [string, string, () => Promise<void>][] = [
    ["registro vacío", "FLOW_RUN_INVALID", () => writeFile(location().statePath, "  \n", "utf8")],
    [
      "registro que no es JSON",
      "FLOW_RUN_INVALID",
      () => writeFile(location().statePath, "{ roto", "utf8"),
    ],
    [
      "registro con forma inválida",
      "FLOW_RUN_INVALID",
      () => sealedWith((state) => ({ ...state, flow: "otro" })),
    ],
    [
      "registro sellado mal",
      "FLOW_RUN_TAMPERED",
      async () => {
        const state = await seated();
        await writeFile(
          location().statePath,
          JSON.stringify({ ...state, applied: [...state.applied, "a.mano"] }),
          "utf8",
        );
      },
    ],
    [
      "registro demasiado viejo para leerse",
      "FLOW_RUN_VERSION_UNSUPPORTED",
      () => sealedWith((state) => ({ ...state, version: 6 })),
    ],
    [
      "registro anterior a la v11",
      "FLOW_RUN_LEGACY_ADOPTION_REQUIRED",
      () => sealedWith(({ journey_base: _base, ...state }) => ({ ...state, version: 10 })),
    ],
    [
      "cursor que el recorrido instalado no sostiene",
      "FLOW_RUN_AHEAD_OF_JOURNEY",
      async () => {
        const { digest: _seal, ...rest } = await seated();
        const next = sealRunState({ ...rest, applied: ["frontera.retirada"] });
        await writeFile(location().statePath, serializeRunState(next), "utf8");
      },
    ],
    [
      "contador de intentos ilegible",
      "FLOW_RUN_COUNTER_INVALID",
      async () => {
        await mkdir(join(location().countersPath, ".."), { recursive: true });
        await writeFile(location().countersPath, "{ roto", "utf8");
      },
    ],
    [
      "contador de intentos revertido",
      "FLOW_RUN_COUNTER_ROLLED_BACK",
      async () => {
        const { digest: _seal, ...rest } = await seated();
        const next = sealRunState({ ...rest, attempt_floor: { [rest.boundary ?? ""]: 2 } });
        await writeFile(location().statePath, serializeRunState(next), "utf8");
      },
    ],
  ];

  for (const [name, code, stick] of CASES) {
    it(`${name} (${code}): su comando deja la corrida avanzable, y no es --adopt`, async () => {
      await stick();
      const refused = await refusal();
      expect(refused.code).toBe(code);
      expect(refused.action).not.toContain("--adopt'");
      expect(await runRemedy(refused.action)).toBe(true);
      const next = await advanceFlow(fs, paths, { code: session, adopt: false });
      expect(next.ok).toBe(true);
      expect((await seated()).version).toBe(FLOW_RUN_STATE_VERSION);
    });
  }

  it("un registro de un CLI más nuevo pide actualizar, y no reiniciar ni adoptar", async () => {
    await sealedWith((state) => ({ ...state, version: FLOW_RUN_STATE_VERSION + 1 }));
    const refused = await refusal();
    expect(refused.code).toBe("FLOW_RUN_VERSION_UNSUPPORTED");
    expect(refused.action).toContain("aw self update");
    expect(refused.action).not.toContain("aw flow restart");
    expect(refused.action).not.toContain("--adopt");
  });

  it("una sesión sin registro es la única que propone --adopt, y la adopta", async () => {
    await rm(location().statePath);
    const refused = await refusal();
    expect(refused.code).toBe("FLOW_RUN_ABSENT");
    expect(refused.message).not.toContain("legacy");
    expect(refused.action).not.toContain("legacy");
    expect(await runRemedy(refused.action)).toBe(true);
    expect((await seated()).flow).toBe("quick");
  });
});
