import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openClaimsOf, readClaimEvents } from "../../src/application/claims-ledger.js";
import { applyRecovery, previewRecovery } from "../../src/application/claims-recovery.js";
import { runNextNumber } from "../../src/application/dev-only-services.js";
import { resolveBoundary } from "../../src/application/flow/advance.js";
import { advanceFlow } from "../../src/application/flow/flow-service.js";
import {
  type InternalActionExecutor,
  internalActionExecutor,
} from "../../src/application/flow/internal-actions.js";
import { locateRun, readRun } from "../../src/application/flow/run-state-service.js";
import { submitFlow } from "../../src/application/flow/submit.js";
import { PathsService } from "../../src/application/paths-service.js";
import { runSessionClose } from "../../src/application/session-close-service.js";
import { CLOSED_MARKER } from "../../src/application/session-resolver.js";
import { nextNumberCommand } from "../../src/cli/commands/dev-only.js";
import { parseArgv } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
import {
  type FlowDecision,
  journeyOfFlow,
  publishApprovalOf,
} from "../../src/domain/flow/authority.js";
import { effectApprovalDigest } from "../../src/domain/flow/authorization.js";
import type { FlowDirective } from "../../src/domain/flow/directive.js";
import { reservationMarker } from "../../src/domain/reservation.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { RecordingGit } from "../helpers/fake-git.js";
import { NodeFileSystem } from "../helpers/real-fs.js";

/**
 * Dos `plan-new` a la vez sobre el mismo `docs/plans`.
 *
 * El seam que fija esta prueba tenía dos mitades y ninguna se veía sola. El
 * reclamo materializaba un archivo VACÍO, así que la corrida no podía distinguir
 * su propio hueco del documento de otro: completarlo se clasificaba como
 * `mutate_overwrite` y la fila de guardado de `plan-new` —que sólo declara
 * `local_additive`— lo rechazaba con `FLOW_PROPOSAL_BEYOND_CONTRACT`. Y una
 * corrida que no llegaba a publicar dejaba ese archivo vacío en `docs/plans`,
 * indistinguible de un plan.
 *
 * Lo que se demuestra acá no es que la numeración funcione, sino DÓNDE está la
 * línea: sólo una reserva propia e intacta se completa, cualquier otro destino
 * existente sigue siendo un overwrite fuera de contrato, la base sigue bajo CAS y
 * cerrar sin publicar devuelve el número.
 */

const JOURNEY = journeyOfFlow("plan-new");
const fs = new NodeFileSystem();

interface Walker {
  code: string;
  folder: string;
  slug: string;
  /** El correlativo que este recorrido reclamó, una vez que pasó por numbering. */
  claimed: string | null;
}

const SESSION_MD = (slug: string) =>
  `# SESSION — ${slug}-plan-new\n\n## Objective\ngenerar el plan de ${slug}\n\n## Success criteria\n- [ ] el plan declara sus fases verificables\n`;

const PLAN_BYTES = (slug: string) =>
  `# Plan — ${slug}\n\n> Estado: open\n\n## Origin\nspec ${slug}\n\n## Tasks\n\n### F1 — arranque\n> Estado: pendiente\n`;

describe("dos plan-new concurrentes reclaman, completan y devuelven su correlativo", () => {
  let workdir: string;
  let paths: PathsService;
  let executor: InternalActionExecutor;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "aw-planes-concurrentes-"));
    paths = new PathsService(normalizeNamespace("agent-workflow"), workdir, workdir);
    await mkdir(join(workdir, "docs/specs"), { recursive: true });
    for (const [code, slug] of [
      ["201", "alpha"],
      ["202", "beta"],
    ] as const) {
      const folder = `${code}-${slug}-plan-new`;
      await mkdir(join(paths.cwdSessionsDir(), folder), { recursive: true });
      await writeFile(join(paths.cwdSessionsDir(), folder, "SESSION.md"), SESSION_MD(slug), "utf8");
      await writeFile(
        join(workdir, "docs/specs", `0${code.slice(1)}-spec-${slug}.md`),
        `---\nstatus: ready-for-plan\n---\n\n# Spec ${slug}\n`,
        "utf8",
      );
    }
    executor = internalActionExecutor({
      fs,
      env: new FakeEnv(workdir, workdir),
      paths,
      git: new RecordingGit(),
    });
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  function walker(code: string, slug: string): Walker {
    return { code, folder: `${code}-${slug}-plan-new`, slug, claimed: null };
  }

  async function current(run: Walker) {
    const read = await readRun(fs, locateRun(paths, run.folder));
    if (!read.ok) throw new Error(`esperaba leer la corrida ${run.code}: ${read.failure.code}`);
    return { state: read.state, resolved: resolveBoundary(read.state, JOURNEY) };
  }

  async function answer(
    run: Walker,
    body: unknown,
    approval: string | null = null,
  ): Promise<FlowDirective> {
    const result = await submitFlow(fs, paths, {
      code: run.code,
      raw: JSON.stringify(body),
      approval,
      executor,
    });
    if (!result.ok) throw new Error("un rechazo de negocio viaja ok:true");
    return result.directive;
  }

  /** El valor que sigue a una bandera dentro de la invocación sellada. */
  function argAfter(args: readonly string[], flag: string): string {
    const value = args[args.indexOf(flag) + 1];
    if (value === undefined) throw new Error(`la invocación sellada no trae '${flag}'`);
    return value;
  }

  /** El destino que este recorrido reservó, relativo al workspace. */
  function reserved(run: Walker): string {
    if (run.claimed === null) throw new Error(`la corrida ${run.code} todavía no reclamó`);
    return `docs/plans/${run.claimed}-plan-${run.slug}.md`;
  }

  /**
   * Contesta la frontera vigente como lo haría el agente: la numeración corre el
   * reclamo DE VERDAD y devuelve su salida como evidencia; el guardado entrega los
   * bytes del plan en el destino reservado.
   */
  async function step(
    run: Walker,
    resolved: Awaited<ReturnType<typeof current>>["resolved"],
    destination?: string,
  ): Promise<FlowDirective> {
    const stopped = resolved.stopped as FlowDecision;
    if (resolved.kind === "execution") {
      const action = resolved.action;
      if (action === null) throw new Error("una frontera de ejecución sin invocación");
      const declared = resolved.proposal?.effects ?? stopped.effects ?? ["read_only"];
      let detail = `salida de ${stopped.id}`;
      if (stopped.id === "plan-new.numbering") {
        // El reclamo sale de la invocación SELLADA, no de un nombre que la prueba
        // arma por su cuenta. Armarlo aparte es lo que dejó pasar `plan-<slug>.md`
        // durante todo un lote: el helper ejecutaba el slug real y reportaba la
        // plantilla, así que las dos mitades nunca se encontraban.
        const claimed = await runNextNumber(fs, new FakeEnv(workdir, workdir), paths, {
          directory: argAfter(action.invocation.args, "next-number"),
          claim: { name: argAfter(action.invocation.args, "--claim"), owner: run.folder },
        });
        run.claimed = claimed.next;
        detail = JSON.stringify(claimed);
      }
      return answer(run, {
        input_digest: resolved.seal,
        outcome: "completed",
        invocation: action.invocation,
        validations: action.evidence.map((id) => ({
          id,
          passed: true,
          detail,
          ...(id === "workline.source-bounded"
            ? {
                proof: {
                  kind: "inspection" as const,
                  source: "workspace",
                  relative_cwd: ".",
                  checkout_digest: "test-checkout",
                  invocation: { artifact: "tests/unit/plan-new-concurrent-numbering.test.ts" },
                },
              }
            : {}),
        })),
        effects: { planned: [...declared], approved: [], applied: [...declared] },
        output: null,
      });
    }
    if (resolved.kind === "semantic") {
      if (stopped.id === "plan-new.save-proposal") {
        return answer(run, {
          input_digest: resolved.seal,
          artifacts: [{ path: destination ?? reserved(run), content: PLAN_BYTES(run.slug) }],
        });
      }
      return answer(run, {
        input_digest: resolved.seal,
        signals: [],
        decisions: { paso: stopped.id },
      });
    }
    if (resolved.kind === "authorization") {
      return answer(
        run,
        { input_digest: resolved.seal, choice: "Autorizar el efecto" },
        effectApprovalDigest(stopped.id, resolved.authorization?.planned ?? []),
      );
    }
    return answer(run, { input_digest: resolved.seal, choice: resolved.choices[0]?.label ?? "" });
  }

  /** Adopta la corrida y la lleva hasta la frontera cuyo id se pide. */
  async function walkTo(run: Walker, target: string, destination?: string): Promise<FlowDirective> {
    const adopted = await advanceFlow(fs, paths, {
      code: run.code,
      flow: "plan-new",
      adopt: true,
      executor,
    });
    if (!adopted.ok) throw new Error(`esperaba adoptar la corrida ${run.code}`);
    let last: FlowDirective = adopted.directive;
    for (let hop = 0; hop < 40; hop += 1) {
      const { resolved } = await current(run);
      if (resolved.stopped === null)
        throw new Error(`el recorrido ${run.code} terminó antes de ${target}`);
      if (resolved.stopped.id === target) return last;
      last = await step(run, resolved, destination);
    }
    throw new Error(`el recorrido ${run.code} nunca llegó a ${target}`);
  }

  /** Aprueba la vista previa vigente y publica. */
  async function approve(run: Walker): Promise<FlowDirective> {
    const gate = await current(run);
    if (publishApprovalOf(gate.resolved.stopped as FlowDecision) === null) {
      throw new Error("la frontera vigente no publica nada");
    }
    return answer(run, { input_digest: gate.resolved.seal, choice: "Aprobar y guardar" });
  }

  async function plans(): Promise<string[]> {
    return (await readdir(join(workdir, "docs/plans"))).sort();
  }

  it("intercalados obtienen dos correlativos y publican dos planes completos", async () => {
    const alpha = walker("201", "alpha");
    const beta = walker("202", "beta");

    // Las dos reservas se toman antes de que cualquiera publique: eso es el
    // solapamiento real, no dos corridas en fila.
    await walkTo(alpha, "plan-new.phase-shaping");
    await walkTo(beta, "plan-new.phase-shaping");
    expect(alpha.claimed).not.toBeNull();
    expect(beta.claimed).not.toBe(alpha.claimed);
    expect(await plans()).toEqual([
      `${alpha.claimed}-plan-alpha.md`,
      `${beta.claimed}-plan-beta.md`,
    ]);

    await walkTo(alpha, "plan-new.save-confirmation");
    const preview = await current(alpha);
    // La mitad que rompía: completar la reserva propia es aditivo, no un
    // reemplazo, así que el contrato de la fila alcanza.
    expect(preview.resolved.proposal?.effects).toEqual(["local_additive"]);
    expect(preview.resolved.proposal?.preview).toEqual([
      {
        path: reserved(alpha),
        bytes: Buffer.byteLength(PLAN_BYTES("alpha"), "utf8"),
        overwrite: true,
      },
    ]);
    // Y sigue bajo compare-and-swap: la reserva es la base del sello.
    expect(preview.state.proposal?.bases.map((base) => base.path)).toEqual([reserved(alpha)]);

    const published = await approve(alpha);
    expect(published.error).toBeNull();
    expect(await readFile(join(workdir, reserved(alpha)), "utf8")).toBe(PLAN_BYTES("alpha"));

    await walkTo(beta, "plan-new.save-confirmation");
    expect((await approve(beta)).error).toBeNull();
    expect(await readFile(join(workdir, reserved(beta)), "utf8")).toBe(PLAN_BYTES("beta"));

    // Dos documentos completos y ningún destino vacío presentado como plan.
    expect(await plans()).toHaveLength(2);
    for (const name of await plans()) {
      const text = await readFile(join(workdir, "docs/plans", name), "utf8");
      expect(text.startsWith("# Plan — ")).toBe(true);
    }
  });

  it("la reserva ajena no se completa: sigue siendo un overwrite fuera de contrato", async () => {
    const alpha = walker("201", "alpha");
    const beta = walker("202", "beta");
    await walkTo(alpha, "plan-new.phase-shaping");
    await walkTo(beta, "plan-new.save-proposal");

    const before = await readFile(join(workdir, reserved(alpha)), "utf8");
    const { resolved } = await current(beta);
    const refused = await step(beta, resolved, reserved(alpha));

    expect(refused.error?.code).toBe("FLOW_PROPOSAL_BEYOND_CONTRACT");
    expect(refused.error?.message).toContain("mutate_overwrite");
    // La reserva de la otra corrida no se tocó: la negativa es antes de escribir.
    expect(await readFile(join(workdir, reserved(alpha)), "utf8")).toBe(before);
  });

  it("un plan existente que nadie reservó tampoco entra en el contrato del guardado", async () => {
    const alpha = walker("201", "alpha");
    await mkdir(join(workdir, "docs/plans"), { recursive: true });
    await writeFile(join(workdir, "docs/plans/009-plan-ajeno.md"), "# Plan ajeno\n", "utf8");
    await walkTo(alpha, "plan-new.save-proposal");

    const { resolved } = await current(alpha);
    const refused = await step(alpha, resolved, "docs/plans/009-plan-ajeno.md");

    expect(refused.error?.code).toBe("FLOW_PROPOSAL_BEYOND_CONTRACT");
    expect(await readFile(join(workdir, "docs/plans/009-plan-ajeno.md"), "utf8")).toBe(
      "# Plan ajeno\n",
    );
  });

  it("una reserva que cambió entre la vista previa y la aprobación detiene la publicación", async () => {
    const alpha = walker("201", "alpha");
    await walkTo(alpha, "plan-new.save-confirmation");
    const gate = await current(alpha);

    // Alguien escribe en el hueco después de la vista previa.
    await writeFile(join(workdir, reserved(alpha)), "# otra cosa\n", "utf8");
    const blocked = await answer(alpha, {
      input_digest: gate.resolved.seal,
      choice: "Aprobar y guardar",
    });

    expect(blocked.error?.code).toBe("FLOW_EVIDENCE_MISSING");
    expect(blocked.error?.message).toContain("cambió después de preparar la propuesta");
    expect(await readFile(join(workdir, reserved(alpha)), "utf8")).toBe("# otra cosa\n");
  });

  it("reclamar dos veces devuelve la misma reserva, no un segundo número", async () => {
    const env = new FakeEnv(workdir, workdir);
    const first = await runNextNumber(fs, env, paths, {
      directory: "docs/plans",
      claim: { name: "plan-alpha.md", owner: "201-alpha-plan-new" },
    });
    const again = await runNextNumber(fs, env, paths, {
      directory: "docs/plans",
      claim: { name: "plan-alpha.md", owner: "201-alpha-plan-new" },
    });

    expect(again.claimed_path).toBe(first.claimed_path);
    expect(again.claim_reused).toBe(true);
    expect(first.claim_reused).toBe(false);
    expect(await plans()).toHaveLength(1);

    // La de otra sesión con el mismo nombre NO es reentrada: es un número nuevo.
    const stranger = await runNextNumber(fs, env, paths, {
      directory: "docs/plans",
      claim: { name: "plan-alpha.md", owner: "202-beta-plan-new" },
    });
    expect(stranger.claimed_path).not.toBe(first.claimed_path);
    expect(await plans()).toHaveLength(2);
  });

  /**
   * Las DOS mitades del defecto que encontró el probe multihost.
   *
   * La fila declaraba su reclamo como `plan-<slug>.md`, con ÁNGULOS: `bindAction`
   * sólo liga un conjunto cerrado con llaves y el guard de placeholder vivo sólo
   * ve esa forma, así que la plantilla viajaba entera hasta quien ejecuta. Y como
   * `invocationMismatch` exige igualdad literal, el agente que sustituía BIEN era
   * el que se rompía: reportaba el slug real, no coincidía con lo sellado, quemaba
   * sus intentos y quedaba `blocked` con una reserva huérfana. El que corría la
   * plantilla al pie de la letra creaba en disco un `NNN-plan-<slug>.md`.
   *
   * Las dos mitades se fijan juntas a propósito: ligar sin verificar dejaría pasar
   * cualquier otro nombre, y verificar sin ligar es exactamente el estado que
   * rompía. Ninguna de las dos sola describe el contrato.
   */
  it("la numeración se sella con el slug ligado y rechaza un resultado con la plantilla", async () => {
    const alpha = walker("201", "alpha");
    await walkTo(alpha, "plan-new.numbering");

    const { resolved } = await current(alpha);
    const action = resolved.action;
    if (action === null) throw new Error("la numeración dejó de delegar su invocación");

    // Mitad 1 — lo sellado es ejecutable tal cual: ni una llave ni un ángulo vivos.
    expect(action.invocation.args).toEqual([
      "next-number",
      "docs/plans",
      "--claim",
      "plan-alpha.md",
      "--code",
      // El FOLDER: es la única identidad que resuelve a una sola sesión.
      "201-alpha-plan-new",
    ]);
    for (const arg of action.invocation.args) {
      expect(arg).not.toMatch(/[{<][a-z_-]+[}>]/);
    }

    // Mitad 2 — reportar la plantilla es reportar otra invocación, y se rechaza.
    const impostor = await answer(alpha, {
      input_digest: resolved.seal,
      outcome: "completed",
      invocation: {
        ...action.invocation,
        args: action.invocation.args.map((arg) =>
          arg === "plan-alpha.md" ? "plan-<slug>.md" : arg,
        ),
      },
      validations: action.evidence.map((id) => ({
        id,
        passed: true,
        detail: "reserva",
        ...(id === "workline.source-bounded"
          ? {
              proof: {
                kind: "inspection" as const,
                source: "workspace",
                relative_cwd: ".",
                checkout_digest: "test-checkout",
                invocation: { artifact: "tests/unit/plan-new-concurrent-numbering.test.ts" },
              },
            }
          : {}),
      })),
      effects: { planned: ["local_additive"], approved: [], applied: ["local_additive"] },
      output: null,
    });

    expect(impostor.error?.code).toBe("FLOW_ACTION_MISMATCH");
    expect(impostor.error?.message).toContain("plan-<slug>.md");
    // Y no se acreditó nada: la corrida sigue parada en la misma frontera.
    const after = await current(alpha);
    expect(after.resolved.stopped?.id).toBe("plan-new.numbering");
  });

  it("una corrida cuya sesión no lleva slug se niega en vez de reclamar un nombre inventado", async () => {
    const folder = "203-plan-new";
    await mkdir(join(paths.cwdSessionsDir(), folder), { recursive: true });
    await writeFile(join(paths.cwdSessionsDir(), folder, "SESSION.md"), SESSION_MD("x"), "utf8");
    const mudo: Walker = { code: "203", folder, slug: "", claimed: null };

    await walkTo(mudo, "plan-new.numbering");
    const { resolved } = await current(mudo);

    expect(resolved.action).toBeNull();
    expect(resolved.error?.code).toBe("FLOW_ACTION_UNBOUND");
    expect(resolved.error?.message).toContain("{slug}");
    // Sin nombre no hay reserva, y la negativa llega ANTES de tocar el disco: la
    // carpeta que el reclamo habría creado ni siquiera nació.
    expect(await fs.exists(join(workdir, "docs/plans"))).toBe(false);
  });

  it("cerrar sin publicar devuelve el correlativo en vez de dejar un plan vacío", async () => {
    const alpha = walker("201", "alpha");
    await walkTo(alpha, "plan-new.phase-shaping");
    const slot = reserved(alpha);
    expect(await plans()).toHaveLength(1);

    const closed = await runSessionClose(fs, paths, { code: "201" });
    if (!("sessionClose" in closed)) throw new Error("esperaba cerrar la sesión");

    expect(closed.sessionClose.reservations_released).toEqual([slot]);
    expect(await plans()).toHaveLength(0);
  });

  it("cerrar no toca el plan publicado ni la reserva de otra sesión", async () => {
    const alpha = walker("201", "alpha");
    const beta = walker("202", "beta");
    await walkTo(alpha, "plan-new.save-confirmation");
    await approve(alpha);
    await walkTo(beta, "plan-new.phase-shaping");

    const closed = await runSessionClose(fs, paths, { code: "201" });
    if (!("sessionClose" in closed)) throw new Error("esperaba cerrar la sesión");

    expect(closed.sessionClose.reservations_released).toBeUndefined();
    expect(await readFile(join(workdir, reserved(alpha)), "utf8")).toBe(PLAN_BYTES("alpha"));
    expect(await readFile(join(workdir, reserved(beta)), "utf8")).toBe(
      reservationMarker(beta.folder),
    );
  });

  it("el reclamo con --code toma como dueña a la sesión que resuelve, y sin ella no reserva de nadie", async () => {
    const ctx = {
      fs,
      env: new FakeEnv(workdir, workdir),
      paths,
    } as unknown as CliContext;

    const owned = await nextNumberCommand.execute(
      parseArgv(["next-number", "docs/plans", "--claim", "plan-alpha.md", "--code", "201"]),
      ctx,
    );
    expect(owned.ok).toBe(true);
    expect((owned.data as { claimed_owner: string }).claimed_owner).toBe("201-alpha-plan-new");

    // Una sesión que no existe no produce una reserva anónima en silencio.
    const unresolved = await nextNumberCommand.execute(
      parseArgv(["next-number", "docs/plans", "--claim", "plan-x.md", "--code", "999"]),
      ctx,
    );
    expect(unresolved.ok).toBe(false);
    expect(await plans()).toHaveLength(1);
  });

  it("un reclamo sin --code se niega antes de crear nada y nombra la vía atómica", async () => {
    const ctx = {
      fs,
      env: new FakeEnv(workdir, workdir),
      paths,
    } as unknown as CliContext;

    const anonymous = await nextNumberCommand.execute(
      parseArgv(["next-number", "docs/plans", "--claim", "plan-huerfano.md"]),
      ctx,
    );

    expect(anonymous.ok).toBe(false);
    // La negativa no basta si el llamador no sabe por dónde seguir: nombra la
    // publicación atómica, que es lo que reemplazó al reclamo anónimo.
    expect(JSON.stringify(anonymous)).toContain("--publish");
    // Y se niega ANTES de cualquier efecto: docs/plans ni siquiera se creó, que
    // es más fuerte que estar vacío.
    await expect(readdir(join(workdir, "docs/plans"))).rejects.toThrow(/ENOENT/);
  });

  it("una sesión cerrada no reclama, y el correlativo no se consume", async () => {
    const folder = "203-cerrada-plan-new";
    await mkdir(join(paths.cwdSessionsDir(), folder), { recursive: true });
    await writeFile(
      join(paths.cwdSessionsDir(), folder, "SESSION.md"),
      SESSION_MD("cerrada"),
      "utf8",
    );
    await writeFile(join(paths.cwdSessionsDir(), folder, CLOSED_MARKER), "", "utf8");
    const ctx = {
      fs,
      env: new FakeEnv(workdir, workdir),
      paths,
    } as unknown as CliContext;

    const closed = await nextNumberCommand.execute(
      parseArgv(["next-number", "docs/plans", "--claim", "plan-cerrada.md", "--code", "203"]),
      ctx,
    );

    expect(closed.ok).toBe(false);
    await expect(readdir(join(workdir, "docs/plans"))).rejects.toThrow(/ENOENT/);
  });

  it("--code sin --claim se niega: una consulta no reserva nada", async () => {
    const ctx = {
      fs,
      env: new FakeEnv(workdir, workdir),
      paths,
    } as unknown as CliContext;

    const consulted = await nextNumberCommand.execute(
      parseArgv(["next-number", "docs/plans", "--code", "201"]),
      ctx,
    );

    expect(consulted.ok).toBe(false);
    await expect(readdir(join(workdir, "docs/plans"))).rejects.toThrow(/ENOENT/);
  });

  it("un flag sin valor se niega en vez de descartar en silencio lo que viene por stdin", async () => {
    const ctx = {
      fs,
      env: new FakeEnv(workdir, workdir),
      paths,
    } as unknown as CliContext;

    // `--publish` sin valor no llega a `values`, así que sin la negativa la
    // invocación se leía como consulta: exit 0, published_path null, y el
    // documento que el llamador venía canalizando, perdido sin aviso.
    const valueless = await nextNumberCommand.execute(
      parseArgv(["next-number", "docs/plans", "--publish"]),
      ctx,
    );

    expect(valueless.ok).toBe(false);
    expect(JSON.stringify(valueless)).toContain("stdin");
    await expect(readdir(join(workdir, "docs/plans"))).rejects.toThrow(/ENOENT/);
  });

  it("un resto de nombre vacío se niega antes de publicar un documento sin nombre", async () => {
    const ctx = {
      fs,
      env: new FakeEnv(workdir, workdir),
      paths,
    } as unknown as CliContext;

    // Publicaba `docs/plans/001-`: un archivo que ningún lector de docs/
    // reconoce, y el correlativo consumido igual.
    const empty = await nextNumberCommand.execute(
      parseArgv(["next-number", "docs/plans", "--publish", ""]),
      ctx,
    );

    expect(empty.ok).toBe(false);
    await expect(readdir(join(workdir, "docs/plans"))).rejects.toThrow(/ENOENT/);
  });

  it("completar la reserva propia queda registrado como publicación, no como liberación", async () => {
    const alpha = walker("201", "alpha");
    await walkTo(alpha, "plan-new.save-confirmation");
    await approve(alpha);

    const read = await readClaimEvents(fs, paths);
    const mine = read.events.filter((e) => e.claim.owner === alpha.folder);
    // El correlativo se gastó para siempre: `published` y `released` son hechos
    // distintos, y confundirlos devolvería al conjunto elegible un número que
    // está sosteniendo un documento.
    expect(mine.map((e) => e.event)).toEqual(["claimed", "published"]);
    expect(openClaimsOf(read.events, alpha.folder)).toEqual([]);
  });

  it("una reserva MODIFICADA no se libera al cerrar: fail-closed sobre bytes inciertos", async () => {
    const alpha = walker("201", "alpha");
    await walkTo(alpha, "plan-new.phase-shaping");
    const slot = join(workdir, reserved(alpha));
    await writeFile(slot, "alguien escribió algo acá que no es el marcador\n", "utf8");

    const closed = await runSessionClose(fs, paths, { code: "201" });
    if (!("sessionClose" in closed)) throw new Error("esperaba cerrar la sesión");

    // Sólo el marcador propio INTACTO se libera. Cualquier otra cosa se preserva
    // hasta una recuperación explícita, porque un archivo con bytes que nadie
    // reconoce puede ser trabajo de alguien.
    expect(closed.sessionClose.reservations_released).toBeUndefined();
    expect(await readFile(slot, "utf8")).toContain("no es el marcador");
    const read = await readClaimEvents(fs, paths);
    expect(read.events.filter((e) => e.event === "released")).toEqual([]);
    // Y sigue abierta: nadie la cerró, así que una recuperación explícita la ve.
    expect(openClaimsOf(read.events, alpha.folder)).toHaveLength(1);
  });

  it("una interrupción sin evento terminal deja la reserva abierta, sin caducidad por reloj", async () => {
    const alpha = walker("201", "alpha");
    await walkTo(alpha, "plan-new.phase-shaping");

    // No hay cierre, ni cancelación, ni publicación: la corrida simplemente se
    // fue. La reserva sigue existiendo y atribuida, y ningún reloj la retira.
    const read = await readClaimEvents(fs, paths);
    expect(read.events.map((e) => e.event)).toEqual(["claimed"]);
    const open = openClaimsOf(read.events, alpha.folder);
    expect(open).toHaveLength(1);
    expect(open[0]?.owner).toBe(alpha.folder);
    expect(await readFile(join(workdir, reserved(alpha)), "utf8")).toBe(
      reservationMarker(alpha.folder),
    );
  });

  it("una publicación sancionada que llega DESPUÉS de la revocación se rechaza", async () => {
    const alpha = walker("201", "alpha");
    // La propuesta queda sellada y aprobada-por-aprobar: es «sancionada».
    await walkTo(alpha, "plan-new.save-confirmation");
    const target = reserved(alpha);

    // Mientras tanto, una recuperación autorizada revoca ese claim y devuelve el
    // correlativo al conjunto elegible.
    const preview = await previewRecovery(fs, paths, target);
    if ("error" in preview) throw new Error(preview.error);
    const recovered = await applyRecovery(fs, paths, {
      target,
      approval: preview.proposal.digest,
    });
    if ("error" in recovered) throw new Error(recovered.error);
    expect(await plans()).toHaveLength(0);

    // Y ahora llega la publicación. Sin el cerco escribiría un documento sobre un
    // número que ya puede ser de otro: el slot no está en disco, así que nada
    // aguas abajo lo vería siquiera como una sobrescritura.
    const after = await approve(alpha);

    expect(JSON.stringify(after)).toContain("revocada");
    expect(await plans()).toHaveLength(0);
  });
});
