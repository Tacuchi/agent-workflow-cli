import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitCliAdapter } from "../../src/adapters/git-cli.js";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { NodeProcess } from "../../src/adapters/node-process.js";
import { PathsService } from "../../src/application/paths-service.js";
import { attributeGitEffects } from "../../src/application/retirement/attribution.js";
import { runSessionCreate } from "../../src/application/session-create-service.js";
import { recordCommit, recordUnitTaken } from "../../src/application/session-custody-recorder.js";
import { readCustody } from "../../src/application/session-custody-service.js";
import type { SessionCustody } from "../../src/domain/session/custody.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";

/**
 * Real git, and the fixtures the phase demands: every shape of local change, a
 * branch of one's own, a merge, a published commit, a dependent descendant, a
 * conflicting revert, an operation in progress, and a commit with no receipt.
 *
 * A fake could not answer any of them. What is being asserted is what GIT does
 * with these states, and the whole value of the attribution is that it agrees.
 */
function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf-8",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "T",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "T",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  }).trim();
}

function gitFails(repo: string, ...args: string[]): boolean {
  try {
    git(repo, ...args);
    return false;
  } catch {
    return true;
  }
}

describe("atribución de efectos Git — fixtures de cada estado, sin reescribir historia", () => {
  let root: string;
  let workspace: string;
  let source: string;
  let paths: PathsService;
  let gitPort: GitCliAdapter;
  const fs = new NodeFileSystem();
  const deps = () => ({ fs, git: gitPort, paths });

  function sessionsDir(): string {
    return join(workspace, ".workflow", "sessions");
  }

  async function newSession(name = "retiro-plan-exec"): Promise<string> {
    const result = await runSessionCreate(fs, paths, { type: "exec", name, objetivo: "o" });
    if ("error" in result) throw new Error(result.error);
    return result.sessionCreate.folder;
  }

  async function custodyOf(folder: string): Promise<SessionCustody> {
    const read = await readCustody(fs, join(sessionsDir(), folder));
    if (read.status !== "present") throw new Error(`custodia ${read.status}`);
    return read.custody;
  }

  /** A session that took `tree` as its own exclusive unit, with the baseline sealed. */
  async function withUnit(folder: string, tree: string, branch: string): Promise<SessionCustody> {
    await recordUnitTaken(deps(), folder, {
      alias: "acme",
      sourcePath: source,
      unitPath: tree,
      unitBranch: branch,
      base: "main",
    });
    return custodyOf(folder);
  }

  async function attribute(custody: SessionCustody) {
    return attributeGitEffects(gitPort, custody, { scratchDir: join(root, "scratch"), opId: "op" });
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "attrib-"));
    workspace = join(root, "ws");
    source = join(root, "acme");
    mkdirSync(sessionsDir(), { recursive: true });
    mkdirSync(join(root, "scratch"), { recursive: true });
    mkdirSync(source, { recursive: true });
    git(source, "init", "--quiet", "--initial-branch=main");
    writeFileSync(join(source, "base.txt"), "base\n");
    writeFileSync(join(source, "renombrame.txt"), "contenido para renombrar\n");
    writeFileSync(join(source, "borrame.txt"), "me van a borrar\n");
    writeFileSync(join(source, "modo.sh"), "#!/bin/sh\necho hola\n");
    git(source, "add", "-A");
    git(source, "commit", "-q", "-m", "inicial");

    paths = new PathsService(normalizeNamespace("workflow"), join(root, "home"), workspace);
    void new FakeEnv(join(root, "home"), workspace);
    gitPort = new GitCliAdapter(new NodeProcess());
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("atribuye TODOS los estados locales de una unidad exclusiva, incluidas las dos mitades de un rename", async () => {
    const folder = await newSession();
    const custody = await withUnit(folder, source, "aw/unit");

    // Cada forma que un cambio local puede tomar.
    writeFileSync(join(source, "staged.txt"), "en el índice\n");
    git(source, "add", "staged.txt");
    writeFileSync(join(source, "base.txt"), "base modificada\n");
    git(source, "mv", "renombrame.txt", "renombrado.txt");
    git(source, "rm", "-q", "borrame.txt");
    writeFileSync(join(source, "sin-trackear.txt"), "nuevo\n");
    writeFileSync(join(source, "binario.bin"), Buffer.from([0, 1, 2, 0, 3]));
    symlinkSync("base.txt", join(source, "enlace.txt"));
    chmodSync(join(source, "modo.sh"), 0o755);

    const attribution = await attribute(custody);
    const change = attribution.dirty[0];
    expect(attribution.blocks).toEqual([]);
    expect(change?.exclusive_unit).toBe(true);
    expect(change?.baseline).toBe(git(source, "rev-parse", "HEAD"));
    // Las dos mitades del rename, el borrado, el untracked, el binario, el symlink
    // y el cambio de modo: cada uno es una decisión distinta y ninguno se pierde.
    expect(change?.paths).toEqual(
      expect.arrayContaining([
        "staged.txt",
        "base.txt",
        "renombrado.txt",
        "renombrame.txt",
        "borrame.txt",
        "sin-trackear.txt",
        "binario.bin",
        "enlace.txt",
        "modo.sh",
      ]),
    );
  });

  it("en un checkout compartido bloquea si un path ya estaba sucio en el baseline", async () => {
    // Trabajo ajeno presente ANTES de que la sesión llegue.
    writeFileSync(join(source, "base.txt"), "modificado por otro\n");
    const folder = await newSession();
    await recordUnitTaken(deps(), folder, {
      alias: "acme",
      sourcePath: source,
      // Sin unidad: la sesión edita el checkout compartido.
      unitPath: null as unknown as string,
      unitBranch: null as unknown as string,
      base: "main",
    });
    const custody = await custodyOf(folder);
    expect(custody.sources[0]?.dirty_paths).toContain("base.txt");

    const attribution = await attribute(custody);
    expect(attribution.dirty).toEqual([]);
    expect(attribution.blocks[0]?.contested).toContain("base.txt");
    expect(attribution.blocks[0]?.reason).toContain("checkout compartido");
  });

  it("prepara los reverts de una rama propia no integrada y sella su único punto de commit", async () => {
    const unit = join(root, "unit");
    git(source, "worktree", "add", "--quiet", "-b", "aw/unit", unit);
    const folder = await newSession();
    await withUnit(folder, unit, "aw/unit");

    writeFileSync(join(unit, "trabajo.txt"), "de la sesión\n");
    git(unit, "add", "-A");
    const receipt = await gitPort.commit(unit, "trabajo de la sesión");
    await recordCommit(deps(), folder, "acme", receipt);
    const custody = await custodyOf(folder);

    const attribution = await attribute(custody);
    expect(attribution.blocks).toEqual([]);
    expect(attribution.reverts).toHaveLength(1);
    expect(attribution.reverts[0]?.commit).toBe(receipt.after);
    expect(attribution.reverts[0]?.mainline).toBeNull();
    expect(attribution.reverts[0]?.published).toBe(false);
    // El punto de commit: un solo ref, con el valor que TIENE que seguir teniendo.
    expect(attribution.publication).toMatchObject({
      alias: "acme",
      ref: "refs/heads/aw/unit",
      expected_old: receipt.after,
    });
    // El resultado se sella como ÁRBOL y no como id de commit: dos construcciones
    // de los mismos reverts dan commits distintos (el id lleva su timestamp) y el
    // mismo árbol, así que el árbol es lo único que puede aprobarse.
    expect(attribution.publication?.expected_tree).toEqual(expect.any(String));
    expect(attribution.publication?.revert_count).toBe(1);
    // Nada se aplicó: el ref sigue donde estaba y el original sigue alcanzable.
    expect(git(source, "rev-parse", "refs/heads/aw/unit")).toBe(receipt.after);
    expect(gitFails(source, "cat-file", "-e", receipt.after)).toBe(false);
  });

  it("un merge se revierte con el parent registrado como mainline", async () => {
    const unit = join(root, "unit");
    git(source, "worktree", "add", "--quiet", "-b", "aw/unit", unit);
    const folder = await newSession();
    await withUnit(folder, unit, "aw/unit");

    // Una rama lateral que la sesión mergea en su unidad.
    git(unit, "checkout", "-q", "-b", "lateral");
    writeFileSync(join(unit, "lateral.txt"), "lateral\n");
    git(unit, "add", "-A");
    git(unit, "commit", "-q", "-m", "lateral");
    git(unit, "checkout", "-q", "aw/unit");
    git(unit, "merge", "--no-ff", "-q", "-m", "merge lateral", "lateral");
    const merge = git(unit, "rev-parse", "HEAD");
    const parents = git(unit, "rev-list", "--parents", "-n", "1", merge).split(" ").slice(1);
    await recordCommit(deps(), folder, "acme", {
      branch: "aw/unit",
      before: parents[0] ?? null,
      after: merge,
      parents,
    });
    const custody = await custodyOf(folder);

    const attribution = await attribute(custody);
    expect(attribution.blocks).toEqual([]);
    // Dos padres → el primero es el lado que sobrevive, y es un hecho del commit.
    expect(attribution.reverts[0]?.parents).toHaveLength(2);
    expect(attribution.reverts[0]?.mainline).toBe(1);
    expect(attribution.publication?.expected_tree).toEqual(expect.any(String));
    expect(attribution.publication?.revert_count).toBe(1);
  });

  it("marca como publicado un commit que ya alcanza un remoto, sin proponer ningún push", async () => {
    const remote = join(root, "remote.git");
    git(root, "init", "--quiet", "--bare", remote);
    const unit = join(root, "unit");
    git(source, "worktree", "add", "--quiet", "-b", "aw/unit", unit);
    const folder = await newSession();
    await withUnit(folder, unit, "aw/unit");

    writeFileSync(join(unit, "publicado.txt"), "ya salió\n");
    git(unit, "add", "-A");
    const receipt = await gitPort.commit(unit, "commit publicado");
    git(unit, "remote", "add", "origin", remote);
    git(unit, "push", "-q", "origin", "aw/unit");
    await recordCommit(deps(), folder, "acme", receipt);

    const attribution = await attribute(await custodyOf(folder));
    expect(attribution.reverts[0]?.published).toBe(true);
    // El revert es un commit local nuevo; publicar queda como acción externa.
    expect(attribution.publication?.ref).toBe("refs/heads/aw/unit");
  });

  it("bloquea cuando un descendiente ajeno depende de los commits del alcance", async () => {
    const unit = join(root, "unit");
    git(source, "worktree", "add", "--quiet", "-b", "aw/unit", unit);
    const folder = await newSession();
    await withUnit(folder, unit, "aw/unit");

    writeFileSync(join(unit, "nuestro.txt"), "nuestro\n");
    git(unit, "add", "-A");
    const receipt = await gitPort.commit(unit, "nuestro commit");
    await recordCommit(deps(), folder, "acme", receipt);
    // Alguien más commitea ENCIMA, sin receipt: su trabajo depende del nuestro.
    writeFileSync(join(unit, "ajeno.txt"), "ajeno\n");
    git(unit, "add", "-A");
    git(unit, "commit", "-q", "-m", "trabajo ajeno encima");
    const external = git(unit, "rev-parse", "HEAD");

    const attribution = await attribute(await custodyOf(folder));
    expect(attribution.reverts).toEqual([]);
    expect(attribution.publication).toBeNull();
    expect(attribution.blocks[0]?.contested).toContain(external);
  });

  it("un revert que no aplica escribe cero y deja los originales alcanzables", async () => {
    const unit = join(root, "unit");
    git(source, "worktree", "add", "--quiet", "-b", "aw/unit", unit);
    const folder = await newSession();
    await withUnit(folder, unit, "aw/unit");

    // Un commit que la sesión hizo en una rama lateral que después quedó
    // abandonada: su receipt sigue nombrándolo, pero su contenido no está en el
    // tip de la unidad, así que revertirlo ahí no puede aplicar.
    git(unit, "checkout", "-q", "-b", "abandonada");
    writeFileSync(join(unit, "abandonado.txt"), "sólo existe acá\n");
    git(unit, "add", "-A");
    const orphan = await gitPort.commit(unit, "commit de una rama abandonada");
    git(unit, "checkout", "-q", "aw/unit");
    await recordCommit(deps(), folder, "acme", { ...orphan, branch: "aw/unit" });

    const refsBefore = git(source, "show-ref");
    const attribution = await attribute(await custodyOf(folder));

    expect(attribution.blocks).toHaveLength(1);
    expect(attribution.blocks[0]?.reason).toContain("no aplica limpio");
    expect(attribution.blocks[0]?.action).toContain("no commitea un revert en conflicto");
    expect(attribution.publication).toBeNull();
    // Cero escritura: ningún ref se movió y el original sigue alcanzable.
    expect(git(source, "show-ref")).toBe(refsBefore);
    expect(gitFails(source, "cat-file", "-e", orphan.after)).toBe(false);
    // Y no quedó ningún árbol de ensayo colgado.
    expect(git(source, "worktree", "list", "--porcelain")).not.toContain("rehearsal-");
  });

  it("con topología lineal propia, revertir de nuevo a viejo nunca entra en conflicto", async () => {
    const unit = join(root, "unit");
    git(source, "worktree", "add", "--quiet", "-b", "aw/unit", unit);
    const folder = await newSession();
    await withUnit(folder, unit, "aw/unit");

    // Dos commits de la sesión sobre EL MISMO archivo: el segundo reescribe la
    // línea del primero. Revertir en topología inversa restituye el terreno antes
    // de deshacer lo anterior, así que aplica limpio — y por eso el caso de
    // conflicto real es el de un commit que no está en la rama, no éste.
    writeFileSync(join(unit, "mismo.txt"), "primera versión\n");
    git(unit, "add", "-A");
    const first = await gitPort.commit(unit, "primera");
    await recordCommit(deps(), folder, "acme", first);
    writeFileSync(join(unit, "mismo.txt"), "segunda versión\n");
    git(unit, "add", "-A");
    const second = await gitPort.commit(unit, "segunda");
    await recordCommit(deps(), folder, "acme", second);

    const attribution = await attribute(await custodyOf(folder));
    expect(attribution.blocks).toEqual([]);
    // Orden de aplicación: el descendiente primero.
    expect(attribution.reverts.map((r) => r.commit)).toEqual([second.after, first.after]);
    expect(attribution.publication?.expected_old).toBe(second.after);
  });

  it("bloquea cuando el repositorio tiene una operación git en curso", async () => {
    const unit = join(root, "unit");
    git(source, "worktree", "add", "--quiet", "-b", "aw/unit", unit);
    const folder = await newSession();
    await withUnit(folder, unit, "aw/unit");

    // Un merge en conflicto, dejado a medias.
    writeFileSync(join(unit, "conflicto.txt"), "nuestro\n");
    git(unit, "add", "-A");
    git(unit, "commit", "-q", "-m", "nuestro");
    git(unit, "checkout", "-q", "-b", "otra", "HEAD~1");
    writeFileSync(join(unit, "conflicto.txt"), "suyo\n");
    git(unit, "add", "-A");
    git(unit, "commit", "-q", "-m", "suyo");
    git(unit, "checkout", "-q", "aw/unit");
    gitFails(unit, "merge", "otra");

    expect(await gitPort.operationState(unit)).toBe("merge");
    const attribution = await attribute(await custodyOf(folder));
    expect(attribution.dirty).toEqual([]);
    expect(attribution.blocks[0]?.reason).toContain("operación git en curso");
  });

  it("no atribuye un commit sin receipt: una sesión legacy no se lleva historia ajena", async () => {
    const unit = join(root, "unit");
    git(source, "worktree", "add", "--quiet", "-b", "aw/unit", unit);
    const folder = await newSession();
    await withUnit(folder, unit, "aw/unit");

    // Commit hecho fuera del CLI: no hay receipt que lo pruebe.
    writeFileSync(join(unit, "sin-receipt.txt"), "quién lo hizo\n");
    git(unit, "add", "-A");
    git(unit, "commit", "-q", "-m", "sin receipt");

    const attribution = await attribute(await custodyOf(folder));
    expect(attribution.reverts).toEqual([]);
    expect(attribution.publication).toBeNull();
    expect(attribution.blocks).toEqual([]);
  });

  it("bloquea cuando el árbol destino no se puede sincronizar al resultado", async () => {
    const unit = join(root, "unit");
    git(source, "worktree", "add", "--quiet", "-b", "aw/unit", unit);
    const folder = await newSession();
    await withUnit(folder, unit, "aw/unit");

    writeFileSync(join(unit, "compartido.txt"), "de la sesión\n");
    git(unit, "add", "-A");
    const receipt = await gitPort.commit(unit, "toca compartido.txt");
    await recordCommit(deps(), folder, "acme", receipt);
    // Trabajo local sin commitear sobre el MISMO archivo que el revert movería:
    // llevar el árbol al resultado lo pisaría.
    writeFileSync(join(unit, "compartido.txt"), "de la sesión\nY ALGO SIN COMMITEAR\n");

    const refsBefore = git(source, "show-ref");
    const attribution = await attribute(await custodyOf(folder));
    expect(attribution.publication).toBeNull();
    expect(attribution.blocks[0]?.reason).toContain("no se puede llevar al resultado");
    expect(attribution.blocks[0]?.action).toContain("antes del punto de commit");
    expect(git(source, "show-ref")).toBe(refsBefore);
  });

  it("rechaza una topología con más de una unidad de publicación antes de mutar", async () => {
    const second = join(root, "otro");
    mkdirSync(second, { recursive: true });
    git(second, "init", "--quiet", "--initial-branch=main");
    writeFileSync(join(second, "a.txt"), "a\n");
    git(second, "add", "-A");
    git(second, "commit", "-q", "-m", "a");

    const unitA = join(root, "unit-a");
    const unitB = join(root, "unit-b");
    git(source, "worktree", "add", "--quiet", "-b", "aw/unit", unitA);
    git(second, "worktree", "add", "--quiet", "-b", "aw/unit", unitB);
    const folder = await newSession();
    await withUnit(folder, unitA, "aw/unit");
    await recordUnitTaken(deps(), folder, {
      alias: "otro",
      sourcePath: second,
      unitPath: unitB,
      unitBranch: "aw/unit",
      base: "main",
    });

    for (const [tree, alias] of [
      [unitA, "acme"],
      [unitB, "otro"],
    ] as Array<[string, string]>) {
      writeFileSync(join(tree, "trabajo.txt"), `de ${alias}\n`);
      git(tree, "add", "-A");
      const receipt = await gitPort.commit(tree, `trabajo en ${alias}`);
      await recordCommit(deps(), folder, alias, receipt);
    }

    const refsBefore = [git(source, "show-ref"), git(second, "show-ref")];
    const attribution = await attribute(await custodyOf(folder));
    expect(attribution.publication).toBeNull();
    expect(attribution.blocks.at(-1)?.reason).toContain("unidades de publicación");
    expect([git(source, "show-ref"), git(second, "show-ref")]).toEqual(refsBefore);
  });

  it("ninguna ruta de retiro puede reescribir historia, forzar o pushear", async () => {
    // Una guarda a nivel de fuente, y falsable: si alguien agrega mañana un
    // `reset --hard` o un `push` a este camino, esta prueba lo dice. Lo que
    // protege no es una convención de estilo — es la única razón por la que
    // aprobar un retiro no puede costarle a nadie historia que ya vio.
    const dirs = [
      join(import.meta.dirname, "..", "..", "src", "application", "retirement"),
      join(import.meta.dirname, "..", "..", "src", "domain", "retirement"),
    ];
    const sources = dirs.flatMap((dir) =>
      readdirSync(dir).map((name) => ({ name, text: readFileSync(join(dir, name), "utf-8") })),
    );
    expect(sources.length).toBeGreaterThan(0);

    for (const file of sources) {
      // Los patrones son de INVOCACIÓN, no palabras sueltas: `reset` es también el
      // nombre de un modo de retiro. Lo que se prohíbe es el flag y el método.
      for (const forbidden of [
        /--hard/,
        /--amend/,
        /--force/,
        /\bgit\.push\b/,
        /\bgit\.checkout\b/,
        /\bgit\.pull\b/,
        /\bgit\.merge\b/,
        // Ningún servicio arma una línea de comandos: todo pasa por el puerto tipado.
        /process\.run|execFile|spawn\(/,
      ]) {
        expect(forbidden.test(file.text), `${file.name} usa ${forbidden}`).toBe(false);
      }
      // Ni atribución por mensaje o tag: la propiedad se prueba con receipts.
      expect(
        /"describe"|"name-rev"|mergeOrigin/.test(file.text),
        `${file.name} lee tags o mensajes`,
      ).toBe(false);
    }

    // Y el puerto tipado no ofrece ninguna operación de reescritura que alguien
    // pudiera llamar más adelante: lo que no existe no se usa por descuido.
    const port = readFileSync(
      join(import.meta.dirname, "..", "..", "src", "ports", "git.ts"),
      "utf-8",
    );
    for (const method of ["resetHard(", "rebase(", "amend(", "forcePush(", "deleteBranch("]) {
      expect(port.includes(method), `GitPort expone ${method}`).toBe(false);
    }
  });

  it("las primitivas del punto de commit hacen exactamente lo que el probe demostró", async () => {
    // El `apply` de F4 se apoya en estas cuatro, así que quedan ejercitadas acá y
    // no sólo declaradas: un CAS que acepta un old vencido, o una sincronización
    // que pisa trabajo local, serían el defecto que ninguna prueba vería.
    const before = git(source, "rev-parse", "refs/heads/main");
    writeFileSync(join(source, "otro.txt"), "otro\n");
    git(source, "add", "-A");
    git(source, "commit", "-q", "-m", "otro escritor");
    const competitor = git(source, "rev-parse", "refs/heads/main");

    // 1 · el CAS rechaza un old-value vencido y no mueve nada.
    const stale = await gitPort.updateRefCas(source, "refs/heads/main", before, before);
    expect(stale.ok).toBe(false);
    expect(stale.why).not.toBe("");
    expect(git(source, "rev-parse", "refs/heads/main")).toBe(competitor);

    // 2 · un ref privado sostiene el resultado preparado sin tocar ninguna rama.
    expect((await gitPort.setRef(source, "refs/aw-op/probe/tip", before)).ok).toBe(true);
    expect(await gitPort.refValue(source, "refs/aw-op/probe/tip")).toBe(before);

    // 3 · el CAS acierta con el old vigente, y sincronizar el árbol lo deja limpio.
    expect((await gitPort.updateRefCas(source, "refs/heads/main", before, competitor)).ok).toBe(
      true,
    );
    expect((await gitPort.syncTree(source, "HEAD")).ok).toBe(true);
    expect(git(source, "status", "--porcelain")).toBe("");
    expect(await gitPort.treeOf(source, "HEAD")).toEqual(expect.any(String));

    // 4 · qué garantiza exactamente el ensayo, y qué no. Una modificación local en
    // un archivo que el cambio de árbol NO toca no estorba, y negarse ahí sería
    // negarse de más. Lo que el ensayo sí ataja es la modificación de un archivo
    // que el resultado reescribiría.
    writeFileSync(join(source, "base.txt"), "modificado a mano\n");
    expect((await gitPort.canSyncTree(source, competitor)).ok).toBe(true);
    git(source, "checkout", "--", "base.txt");
    git(source, "checkout", "-q", competitor);
    writeFileSync(join(source, "otro.txt"), "modificado a mano\n");
    const refused = await gitPort.canSyncTree(source, before);
    expect(refused.ok).toBe(false);
    expect(refused.why).not.toBe("");
    expect(readFileSync(join(source, "otro.txt"), "utf-8")).toBe("modificado a mano\n");

    // 5 · el ref privado se retira sin dejar rastro, y el commit sigue alcanzable.
    expect((await gitPort.deleteRef(source, "refs/aw-op/probe/tip")).ok).toBe(true);
    expect(await gitPort.refValue(source, "refs/aw-op/probe/tip")).toBeNull();
    expect(gitFails(source, "cat-file", "-e", competitor)).toBe(false);
  });

  it("bloquea cuando el resultado crearía un archivo donde hay uno sin trackear", async () => {
    // El agujero que el ensayo de git NO ve: `read-tree -n` no tiene árbol de
    // trabajo que mirar, y la versión que sí lo mira (`-u`) ya estaría haciendo el
    // cambio — después del punto de commit, que es justo el éxito parcial que la
    // precondición existe para evitar. Por eso la atribución lo comprueba aparte.
    const unit = join(root, "unit");
    git(source, "worktree", "add", "--quiet", "-b", "aw/unit", unit);
    const folder = await newSession();
    await withUnit(folder, unit, "aw/unit");

    // La sesión BORRÓ un archivo en su commit: revertirlo lo volvería a crear.
    git(unit, "rm", "-q", "borrame.txt");
    const receipt = await gitPort.commit(unit, "la sesión borra borrame.txt");
    await recordCommit(deps(), folder, "acme", receipt);
    // Y alguien dejó un archivo sin trackear exactamente ahí.
    writeFileSync(join(unit, "borrame.txt"), "escrito a mano, sin versionar\n");

    const refsBefore = git(source, "show-ref");
    const attribution = await attribute(await custodyOf(folder));

    expect(attribution.publication).toBeNull();
    expect(attribution.blocks[0]?.reason).toContain("sin trackear");
    expect(attribution.blocks[0]?.contested).toContain("borrame.txt");
    expect(git(source, "show-ref")).toBe(refsBefore);
    expect(readFileSync(join(unit, "borrame.txt"), "utf-8")).toBe(
      "escrito a mano, sin versionar\n",
    );
  });
});
