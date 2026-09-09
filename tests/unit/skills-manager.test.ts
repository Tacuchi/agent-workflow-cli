import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import {
  type ApplyResult,
  applySkillChange,
  readSkillJournal,
  recoverSkillJournal,
  skillsJournalPath,
} from "../../src/application/self/skills-apply.js";
import {
  type SkillChangeRequest,
  prepareSkillChange,
} from "../../src/application/self/skills-change.js";
import {
  REPLICA_MARKER_FILENAME,
  canonicalSkillsRoot,
  claudeReplicaRoot,
  geminiReplicaRoot,
  listSkills,
  resolveSkillSource,
} from "../../src/application/self/skills-manager.js";
import { readSkillsRegistry } from "../../src/application/self/skills-registry.js";
import type { CliContext } from "../../src/cli/types.js";
import { FakeEnv } from "../helpers/fake-env.js";

/** Real adapter whose every write path throws: what a read-only journey must
 *  never reach. Reads keep working, so the projection is exercised for real. */
class WriteProofFs extends NodeFileSystem {
  override async writeText(): Promise<void> {
    throw new Error("writeText en un recorrido de solo lectura");
  }
  override async mkdirp(): Promise<void> {
    throw new Error("mkdirp en un recorrido de solo lectura");
  }
  override async remove(): Promise<void> {
    throw new Error("remove en un recorrido de solo lectura");
  }
  override async symlink(): Promise<void> {
    throw new Error("symlink en un recorrido de solo lectura");
  }
}

/** Real adapter whose symlink fails — simulates Windows without links (copy fallback). */
class NoSymlinkFs extends NodeFileSystem {
  override async symlink(): Promise<void> {
    const err = new Error("EPERM: operation not permitted") as Error & { code: string };
    err.code = "EPERM";
    throw err;
  }
}

function buildCtx(home: string, fs: NodeFileSystem = new NodeFileSystem()): CliContext {
  return { fs, env: new FakeEnv(home) } as unknown as CliContext;
}

async function makeSkillDir(parent: string, name: string, marker = "v1"): Promise<string> {
  const dir = join(parent, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: test skill ${name}\n---\n${marker}\n`,
    "utf8",
  );
  return dir;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

async function makeGitSource(root: string, skills: string[]): Promise<string> {
  const repo = join(root, "skills-repo");
  await mkdir(join(repo, "skills"), { recursive: true });
  for (const s of skills) await makeSkillDir(join(repo, "skills"), s);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "test@test");
  git(repo, "config", "user.name", "test");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "v1");
  return repo;
}

// ===== The ONE door (Spec 043) =====
// Since Spec 043 an installation changes in exactly one way: prepare a
// proposal, then apply it against that proposal's own digest. These two
// helpers are that door, and every case below goes through them — which is
// also what proves there is no other way in.

/** Applies a change, failing loudly if the preparation did not come back ready. */
async function applyChange(ctx: CliContext, request: SkillChangeRequest): Promise<ApplyResult> {
  const prepared = await prepareSkillChange(ctx, request);
  if (prepared.status !== "prepared") {
    throw new Error(
      `la preparación no quedó lista: ${prepared.status}${
        prepared.status === "rejected" ? ` (${prepared.rejection.code})` : ""
      }`,
    );
  }
  try {
    const applied = await applySkillChange(ctx, prepared.proposal, prepared.proposal.digest);
    if (applied.status !== "applied")
      throw new Error(`aplicación rehusada: ${applied.refusal.code}`);
    return applied.result;
  } finally {
    await prepared.release();
  }
}

/** Registers + installs a local source in one approved change (test setup). */
async function install(ctx: CliContext, source: string, paths?: string[]): Promise<ApplyResult> {
  return applyChange(ctx, {
    operation: "install",
    source,
    ...(paths !== undefined ? { paths } : {}),
  });
}

describe("resolveSkillSource", () => {
  it("clasifica owner/repo (GitHub), URLs git con #ref y paths absolutos", () => {
    expect(resolveSkillSource("anthropics/skills")).toEqual({
      kind: "git",
      url: "https://github.com/anthropics/skills.git",
    });
    expect(resolveSkillSource("https://x.dev/r.git#v2")).toEqual({
      kind: "git",
      url: "https://x.dev/r.git",
      ref: "v2",
    });
    expect(resolveSkillSource("/abs/dir")).toEqual({ kind: "local", path: "/abs/dir" });
  });

  it("rechaza vacío y paths relativos con error claro (no los confunde con owner/repo)", () => {
    expect(resolveSkillSource("")).toHaveProperty("error");
    expect(resolveSkillSource("./relativo")).toHaveProperty("error");
    expect(resolveSkillSource("../fuera")).toHaveProperty("error");
    expect(resolveSkillSource(".hidden/repo")).toHaveProperty("error");
  });
});

describe("cambios administrados: prepare + apply (Spec 043)", () => {
  let root: string;
  let home: string;
  let ctx: CliContext;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "aw-skills-manager-"));
    home = join(root, "home");
    await mkdir(home, { recursive: true });
    ctx = buildCtx(home);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("una fuente con varias skills pide elegir, y la ruta elegida es la que se registra", async () => {
    const source = join(root, "container");
    await mkdir(join(source, "skills"), { recursive: true });
    await makeSkillDir(join(source, "skills"), "pdf");
    await makeSkillDir(join(source, "skills"), "docx");

    const needsChoice = await prepareSkillChange(ctx, { operation: "register", source });
    expect(needsChoice.status).toBe("needs-choice");
    if (needsChoice.status === "needs-choice") {
      expect(needsChoice.candidates.map((c) => c.name).sort()).toEqual(["docx", "pdf"]);
      await needsChoice.release();
    }
    // Y elegir no instaló nada por el camino.
    expect(existsSync(canonicalSkillsRoot(home))).toBe(false);

    await applyChange(ctx, { operation: "register", source, paths: ["skills/pdf"] });
    const { registry } = await readSkillsRegistry(ctx);
    expect(registry.skills.pdf?.source).toBe(source);
    expect(registry.skills.pdf?.path).toBe("skills/pdf");
    expect(registry.skills.pdf?.installedAt).toBeUndefined();
    expect(existsSync(join(canonicalSkillsRoot(home), "pdf"))).toBe(false);
  });

  it("un dir que ES una skill se registra directo por su frontmatter name", async () => {
    const dir = await makeSkillDir(root, "pdf");
    await applyChange(ctx, { operation: "register", source: dir });
    const { registry } = await readSkillsRegistry(ctx);
    expect(registry.skills.pdf?.source).toBe(dir);
  });

  it("registro duplicado y colisión con dir canónico ajeno se rechazan con su código", async () => {
    const dir = await makeSkillDir(root, "pdf");
    await applyChange(ctx, { operation: "register", source: dir });

    const duplicate = await prepareSkillChange(ctx, { operation: "register", source: dir });
    expect(duplicate.status).toBe("rejected");
    if (duplicate.status === "rejected") {
      expect(duplicate.rejection.code).toBe("SKILL_ALREADY_REGISTERED");
    }

    // Canónica ajena bajo otro nombre: registrarla rehúsa por colisión.
    const other = await makeSkillDir(root, "ajena");
    await makeSkillDir(canonicalSkillsRoot(home), "ajena");
    const collision = await prepareSkillChange(ctx, { operation: "register", source: other });
    expect(collision.status).toBe("rejected");
    if (collision.status === "rejected") {
      expect(collision.rejection.code).toBe("SKILL_NAME_COLLISION");
    }
  });

  it("el prefijo reservado del bundle se rechaza antes de tocar nada", async () => {
    const dir = await makeSkillDir(root, "w-plan-exec");
    const outcome = await prepareSkillChange(ctx, { operation: "register", source: dir });
    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") {
      expect(outcome.rejection.code).toBe("RESERVED_SKILL_PREFIX");
    }
  });

  it("install materializa canónica + symlink a Claude y persiste mode/installedAt", async () => {
    const dir = await makeSkillDir(root, "pdf");

    const result = await install(ctx, dir);

    const canonical = join(canonicalSkillsRoot(home), "pdf");
    expect(await readFile(join(canonical, "SKILL.md"), "utf8")).toContain("name: pdf");
    const replica = await lstat(join(claudeReplicaRoot(home), "pdf"));
    expect(replica.isSymbolicLink()).toBe(true);
    const { registry } = await readSkillsRegistry(ctx);
    expect(registry.skills.pdf?.mode).toBe("symlink");
    expect(registry.skills.pdf?.installedAt).toMatch(/^\d{4}-/);
    expect(registry.skills.pdf?.payloadDigest).toMatch(/^[0-9a-f]{64}$/);
    // El resultado distingue aplicado de comprobado, por destino.
    const canonicalResult = result.destinations.find((d) => d.host === "agents");
    expect(canonicalResult?.status).toBe("applied");
    expect(canonicalResult?.verification?.passed).toBe(true);
    expect(result.recovery).toBeNull();
    // Y no dejó journal: la operación concluyó y se verificó.
    expect(existsSync(skillsJournalPath(home))).toBe(false);
  });

  it("sin symlink disponible cae a copia y registra mode=copy", async () => {
    const dir = await makeSkillDir(root, "pdf");
    const noLinkCtx = buildCtx(home, new NoSymlinkFs());

    const prepared = await prepareSkillChange(noLinkCtx, { operation: "install", source: dir });
    if (prepared.status !== "prepared") throw new Error(`estado ${prepared.status}`);
    try {
      // El fallo de symlink es del filesystem real, no del puerto: el propio
      // `symlink` de node es el que falla en Windows sin Developer Mode.
      const applied = await applySkillChange(
        noLinkCtx,
        prepared.proposal,
        prepared.proposal.digest,
      );
      expect(applied.status).toBe("applied");
    } finally {
      await prepared.release();
    }
    const replica = join(claudeReplicaRoot(home), "pdf");
    expect(existsSync(join(replica, "SKILL.md"))).toBe(true);
  });

  it("una réplica ajena en ~/.claude/skills bloquea el cambio antes de prepararlo", async () => {
    const dir = await makeSkillDir(root, "pdf");
    await applyChange(ctx, { operation: "register", source: dir });
    await makeSkillDir(claudeReplicaRoot(home), "pdf");

    const outcome = await prepareSkillChange(ctx, { operation: "install", source: dir });
    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") expect(outcome.rejection.code).toBe("FOREIGN_REPLICA");
    // La ajena se conserva intacta.
    expect(existsSync(join(claudeReplicaRoot(home), "pdf", "SKILL.md"))).toBe(true);
  });

  it("réplica gemini: install crea COPY con marker (agy no lee el ancla ni sigue symlinks)", async () => {
    const dir = await makeSkillDir(root, "pdf");
    await install(ctx, dir);

    const replica = join(geminiReplicaRoot(home), "pdf");
    expect((await lstat(replica)).isDirectory()).toBe(true);
    expect(existsSync(join(replica, REPLICA_MARKER_FILENAME))).toBe(true);
    expect(await readFile(join(replica, "SKILL.md"), "utf8")).toContain("name: pdf");
  });

  it("un dir gemini ajeno homónimo (sin marker) bloquea el cambio y se preserva", async () => {
    const dir = await makeSkillDir(root, "pdf");
    await applyChange(ctx, { operation: "register", source: dir });
    await makeSkillDir(geminiReplicaRoot(home), "pdf", "ajena");

    const outcome = await prepareSkillChange(ctx, { operation: "install", source: dir });
    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") expect(outcome.rejection.code).toBe("FOREIGN_REPLICA");
    expect(await readFile(join(geminiReplicaRoot(home), "pdf", "SKILL.md"), "utf8")).toContain(
      "ajena",
    );
  });

  it("uninstall desmonta canónica y AMBAS réplicas, y conserva el registro", async () => {
    const dir = await makeSkillDir(root, "pdf");
    await install(ctx, dir);

    const result = await applyChange(ctx, { operation: "uninstall", name: "pdf" });

    expect(existsSync(join(canonicalSkillsRoot(home), "pdf"))).toBe(false);
    expect(await lstat(join(claudeReplicaRoot(home), "pdf")).catch(() => null)).toBeNull();
    expect(existsSync(join(geminiReplicaRoot(home), "pdf"))).toBe(false);
    const { registry } = await readSkillsRegistry(ctx);
    expect(registry.skills.pdf?.source).toBe(dir);
    expect(registry.skills.pdf?.installedAt).toBeUndefined();
    expect(registry.skills.pdf?.mode).toBeUndefined();
    // La identidad que resolvió la selección se conserva para reinstalar.
    expect(registry.skills.pdf?.payloadDigest).toMatch(/^[0-9a-f]{64}$/);
    for (const destination of result.destinations.filter((d) => d.host !== "registry")) {
      expect(destination.verification?.passed).toBe(true);
    }
  });

  it("remove además quita la entrada; una recomendada vuelve a 'recommended' en la lista", async () => {
    const dir = await makeSkillDir(root, "pdf");
    const catalog = [{ name: "pdf", source: "anthropics/skills", description: "PDF tooling" }];
    await install(ctx, dir);

    await applyChange(ctx, { operation: "remove", name: "pdf" });

    const { registry } = await readSkillsRegistry(ctx);
    expect(registry.skills.pdf).toBeUndefined();
    const list = await listSkills(ctx, catalog);
    expect(list).toHaveLength(1);
    expect(list[0]?.status).toBe("recommended");
  });

  it("update re-fetchea el ref registrado y refleja el nuevo contenido", async () => {
    const repo = await makeGitSource(root, ["pdf"]);
    const source = `file://${repo}`;
    await install(ctx, source, ["skills/pdf"]);
    const canonical = join(canonicalSkillsRoot(home), "pdf");
    expect(await readFile(join(canonical, "SKILL.md"), "utf8")).toContain("v1");

    await makeSkillDir(join(repo, "skills"), "pdf", "v2");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "v2");

    await applyChange(ctx, { operation: "update", source, paths: ["skills/pdf"] });

    expect(await readFile(join(canonical, "SKILL.md"), "utf8")).toContain("v2");
    const { registry } = await readSkillsRegistry(ctx);
    expect(registry.skills.pdf?.resolvedRef).toMatch(/^[0-9a-f]{40}$/);
  });

  it("un update cuya fuente desapareció deja la instalación previa intacta", async () => {
    const repo = await makeGitSource(root, ["pdf"]);
    await install(ctx, `file://${repo}`, ["skills/pdf"]);
    const canonical = join(canonicalSkillsRoot(home), "pdf");
    await rm(repo, { recursive: true, force: true });

    const outcome = await prepareSkillChange(ctx, {
      operation: "update",
      source: `file://${repo}`,
      paths: ["skills/pdf"],
    });

    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") expect(outcome.rejection.code).toBe("GIT_CLONE_FAILED");
    expect(await readFile(join(canonical, "SKILL.md"), "utf8")).toContain("v1");
  });

  it("update sobre una fuente de path local rehúsa: no hay ref que re-fetchear", async () => {
    const dir = await makeSkillDir(root, "pdf");
    await install(ctx, dir);

    const outcome = await prepareSkillChange(ctx, { operation: "update", source: dir });

    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") expect(outcome.rejection.code).toBe("UPDATE_REQUIRES_GIT");
  });

  it("repair rehace las réplicas desde la canónica sin volver a la red", async () => {
    const dir = await makeSkillDir(root, "pdf");
    await install(ctx, dir);
    await rm(join(claudeReplicaRoot(home), "pdf"), { recursive: true, force: true });
    // La fuente desaparece: reparar no debe necesitarla.
    await rm(dir, { recursive: true, force: true });

    const result = await applyChange(ctx, { operation: "repair", name: "pdf" });

    expect((await lstat(join(claudeReplicaRoot(home), "pdf"))).isSymbolicLink()).toBe(true);
    // La canónica no se toca en una reparación.
    expect(result.destinations.find((d) => d.host === "agents")?.status).toBe("unchanged");
  });

  it("repair sobre una canónica que este manager no materializó rehúsa en vez de declararla reparada", async () => {
    const dir = await makeSkillDir(root, "pdf");
    await applyChange(ctx, { operation: "register", source: dir });
    await makeSkillDir(canonicalSkillsRoot(home), "pdf", "de otro");

    const outcome = await prepareSkillChange(ctx, { operation: "repair", name: "pdf" });

    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") {
      // La colisión de propiedad se detecta antes que cualquier otra cosa.
      expect(["SKILL_NAME_COLLISION", "SKILL_NOT_INSTALLED"]).toContain(outcome.rejection.code);
    }
    expect(await readFile(join(canonicalSkillsRoot(home), "pdf", "SKILL.md"), "utf8")).toContain(
      "de otro",
    );
  });

  it("operaciones sobre nombres no registrados rehúsan (guard de propiedad)", async () => {
    for (const operation of ["repair", "uninstall", "remove"] as const) {
      const outcome = await prepareSkillChange(ctx, { operation, name: "w" });
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") {
        expect(outcome.rejection.code).toBe("SKILL_NOT_REGISTERED");
      }
    }
    expect(existsSync(join(canonicalSkillsRoot(home), "w"))).toBe(false);
  });

  it("un repo git cuya raíz ES la skill se registra por su frontmatter name, nunca por el tempdir", async () => {
    const repo = join(root, "root-skill");
    await mkdir(repo, { recursive: true });
    await writeFile(
      join(repo, "SKILL.md"),
      "---\nname: structurizr-c4\ndescription: root skill\n---\ncuerpo\n",
      "utf8",
    );
    git(repo, "init", "-b", "main");
    git(repo, "config", "user.email", "test@test");
    git(repo, "config", "user.name", "test");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "v1");

    await install(ctx, `file://${repo}`, [""]);

    const { registry } = await readSkillsRegistry(ctx);
    expect(Object.keys(registry.skills)).toEqual(["structurizr-c4"]);
    expect(existsSync(join(canonicalSkillsRoot(home), "structurizr-c4", "SKILL.md"))).toBe(true);
  });

  it("git manifest-only: la instalación materializa el dir completo, no sólo el SKILL.md", async () => {
    const repo = join(root, "assets-repo");
    const skill = join(repo, "skills", "mcp-builder");
    await makeSkillDir(join(repo, "skills"), "mcp-builder");
    await mkdir(join(skill, "references"), { recursive: true });
    await writeFile(join(skill, "references", "guide.md"), "# guía\n", "utf8");
    git(repo, "init", "-b", "main");
    git(repo, "config", "user.email", "test@test");
    git(repo, "config", "user.name", "test");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "v1");

    await install(ctx, `file://${repo}`, ["skills/mcp-builder"]);

    const canonical = join(canonicalSkillsRoot(home), "mcp-builder");
    expect(existsSync(join(canonical, "references", "guide.md"))).toBe(true);
    expect(existsSync(join(canonical, "references", "workline-provenance", "PROVENANCE.md"))).toBe(
      true,
    );
  });

  it("un registro corrupto aborta toda mutación y el archivo queda intacto", async () => {
    const dir = await makeSkillDir(root, "pdf");
    await mkdir(join(home, ".agents"), { recursive: true });
    const registryPath = join(home, ".agents", ".skills-registry.json");
    await writeFile(registryPath, "{roto", "utf8");

    for (const request of [
      { operation: "install" as const, source: dir },
      { operation: "remove" as const, name: "pdf" },
    ]) {
      const outcome = await prepareSkillChange(ctx, request);
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") {
        expect(outcome.rejection.code).toBe("REGISTRY_UNREADABLE");
      }
    }
    expect(readFileSync(registryPath, "utf8")).toBe("{roto");
  });

  it("un symlink del usuario hacia OTRO lado es ajeno: el cambio aborta sin mutar nada", async () => {
    const dir = await makeSkillDir(root, "pdf");
    await install(ctx, dir);
    // El usuario re-apunta la réplica a otro sitio.
    const elsewhere = await makeSkillDir(root, "otra-cosa");
    const replica = join(claudeReplicaRoot(home), "pdf");
    await rm(replica, { recursive: true, force: true });
    await symlink(elsewhere, replica);

    const outcome = await prepareSkillChange(ctx, { operation: "repair", name: "pdf" });

    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") expect(outcome.rejection.code).toBe("FOREIGN_REPLICA");
    expect((await lstat(replica)).isSymbolicLink()).toBe(true);
  });

  it("una canónica ajena bajo un nombre registrado-sin-instalar se conserva al remover", async () => {
    const dir = await makeSkillDir(root, "pdf");
    await applyChange(ctx, { operation: "register", source: dir });
    await makeSkillDir(canonicalSkillsRoot(home), "pdf", "ajena");

    const result = await applyChange(ctx, { operation: "remove", name: "pdf" });

    const { registry } = await readSkillsRegistry(ctx);
    expect(registry.skills.pdf).toBeUndefined();
    // No la borró: la declara conservada.
    expect(await readFile(join(canonicalSkillsRoot(home), "pdf", "SKILL.md"), "utf8")).toContain(
      "ajena",
    );
    const canonical = result.destinations.find((d) => d.host === "agents");
    expect(canonical?.status).toBe("unchanged");
    expect(canonical?.detail).toContain("no lo materializó este manager");
  });

  it("materializar nunca sigue symlinks de la fuente (un repo hostil no exfiltra archivos)", async () => {
    const secret = join(root, "secreto.txt");
    await writeFile(secret, "no debería viajar\n", "utf8");
    const dir = await makeSkillDir(root, "hostil");
    await symlink(secret, join(dir, "robado.txt"));

    await install(ctx, dir);

    const canonical = join(canonicalSkillsRoot(home), "hostil");
    expect(existsSync(join(canonical, "SKILL.md"))).toBe(true);
    expect(existsSync(join(canonical, "robado.txt"))).toBe(false);
  });
});

describe("aplicación recuperable: journal, respaldos y compensación (Spec 043 · F3)", () => {
  let root: string;
  let home: string;
  let ctx: CliContext;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "aw-skills-apply-"));
    home = join(root, "home");
    await mkdir(home, { recursive: true });
    ctx = buildCtx(home);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** Makes the gemini replica root READ-ONLY: its ownership is still readable
   *  (so the preparation goes through) and publishing into it fails after the
   *  other destinations were already published — the compensation path. */
  async function breakGeminiRoot(): Promise<void> {
    await mkdir(geminiReplicaRoot(home), { recursive: true });
    await chmod(geminiReplicaRoot(home), 0o555);
  }

  /** Gives it back, so the temp dir can be removed. */
  async function fixGeminiRoot(): Promise<void> {
    await chmod(geminiReplicaRoot(home), 0o755).catch(() => {});
  }

  it("una aprobación que no corresponde a la propuesta no aplica nada", async () => {
    const dir = await makeSkillDir(root, "pdf");
    const prepared = await prepareSkillChange(ctx, { operation: "install", source: dir });
    if (prepared.status !== "prepared") throw new Error(`estado ${prepared.status}`);
    try {
      const outcome = await applySkillChange(ctx, prepared.proposal, "otra-cosa");
      expect(outcome.status).toBe("refused");
      if (outcome.status === "refused") expect(outcome.refusal.code).toBe("APPROVAL_MISMATCH");
    } finally {
      await prepared.release();
    }
    expect(existsSync(canonicalSkillsRoot(home))).toBe(false);
  });

  it("una aprobación vieja no autoriza el estado nuevo: el registro cambió", async () => {
    const dir = await makeSkillDir(root, "pdf");
    const stale = await prepareSkillChange(ctx, { operation: "install", source: dir });
    if (stale.status !== "prepared") throw new Error(`estado ${stale.status}`);
    try {
      // Otra corrida instala esa misma skill mientras la vista previa estaba abierta.
      await install(ctx, dir);
      const outcome = await applySkillChange(ctx, stale.proposal, stale.proposal.digest);
      expect(outcome.status).toBe("refused");
      if (outcome.status === "refused") {
        expect(outcome.refusal.code).toBe("PROPOSAL_STALE");
        expect(outcome.refusal.action).toContain("volvé a preparar");
      }
    } finally {
      await stale.release();
    }
  });

  it("un fallo en una réplica compensa en orden inverso y no deja nada a medias", async () => {
    const dir = await makeSkillDir(root, "pdf");
    await breakGeminiRoot();

    const prepared = await prepareSkillChange(ctx, { operation: "install", source: dir });
    if (prepared.status !== "prepared") throw new Error(`estado ${prepared.status}`);
    let result: ApplyResult;
    try {
      const outcome = await applySkillChange(ctx, prepared.proposal, prepared.proposal.digest);
      if (outcome.status !== "applied") throw new Error(`rehusada: ${outcome.refusal.code}`);
      result = outcome.result;
    } finally {
      await prepared.release();
    }

    await fixGeminiRoot();
    expect(result.recovery?.pending).toEqual([]);
    expect(result.recovery?.restored.length).toBeGreaterThan(0);
    expect(result.summary).toContain("Falló");
    // Nada quedó publicado, y el registro no se movió.
    expect(existsSync(join(canonicalSkillsRoot(home), "pdf"))).toBe(false);
    expect(await lstat(join(claudeReplicaRoot(home), "pdf")).catch(() => null)).toBeNull();
    const { registry } = await readSkillsRegistry(ctx);
    expect(registry.skills.pdf).toBeUndefined();
    // Y ninguna comprobación se declara verde: no hubo qué comprobar.
    for (const destination of result.destinations) {
      expect(destination.verification).toBeNull();
    }
    // Compensación completa ⇒ no queda journal pendiente.
    expect(await readSkillJournal(ctx)).toBeNull();
  });

  it("una sustitución que falla conserva la colección anterior byte a byte", async () => {
    const collection = await makeSkillDir(root, "context-engineering-collection", "coleccion v1");
    await install(ctx, collection);
    const canonical = join(canonicalSkillsRoot(home), "context-engineering-collection");
    const before = await readFile(join(canonical, "SKILL.md"), "utf8");

    const leaves = join(root, "leaves");
    await makeSkillDir(join(leaves, "skills"), "tool-design");
    await makeSkillDir(join(leaves, "skills"), "evaluation");
    await breakGeminiRoot();

    const prepared = await prepareSkillChange(ctx, {
      operation: "replace",
      source: leaves,
      paths: ["skills/tool-design", "skills/evaluation"],
      withdraw: ["context-engineering-collection"],
    });
    if (prepared.status !== "prepared") throw new Error(`estado ${prepared.status}`);
    try {
      const outcome = await applySkillChange(ctx, prepared.proposal, prepared.proposal.digest);
      if (outcome.status !== "applied") throw new Error(`rehusada: ${outcome.refusal.code}`);
      expect(outcome.result.recovery?.pending).toEqual([]);
    } finally {
      await prepared.release();
      await fixGeminiRoot();
    }

    // La instalación anterior sigue ahí, con sus mismos bytes.
    expect(await readFile(join(canonical, "SKILL.md"), "utf8")).toBe(before);
    const { registry } = await readSkillsRegistry(ctx);
    expect(registry.skills["context-engineering-collection"]?.installedAt).toBeDefined();
    expect(registry.skills["tool-design"]).toBeUndefined();
  });

  it("la sustitución completa de una colección por hojas deja sólo las hojas", async () => {
    const collection = await makeSkillDir(root, "context-engineering-collection");
    await install(ctx, collection);

    const leaves = join(root, "leaves");
    await makeSkillDir(join(leaves, "skills"), "tool-design");
    await makeSkillDir(join(leaves, "skills"), "evaluation");

    const result = await applyChange(ctx, {
      operation: "replace",
      source: leaves,
      paths: ["skills/tool-design", "skills/evaluation"],
      withdraw: ["context-engineering-collection"],
    });

    const canonicalRoot = canonicalSkillsRoot(home);
    expect(existsSync(join(canonicalRoot, "tool-design", "SKILL.md"))).toBe(true);
    expect(existsSync(join(canonicalRoot, "evaluation", "SKILL.md"))).toBe(true);
    expect(existsSync(join(canonicalRoot, "context-engineering-collection"))).toBe(false);
    const { registry } = await readSkillsRegistry(ctx);
    expect(Object.keys(registry.skills).sort()).toEqual(["evaluation", "tool-design"]);
    // Cada destino con su comprobación propia, incluida la del retiro.
    const failed = result.destinations.filter((d) => d.verification?.passed === false);
    expect(failed).toEqual([]);
    // El retiro también se comprueba: la ubicación ya no existe.
    const removed = result.destinations.filter((d) =>
      d.location.endsWith("context-engineering-collection"),
    );
    expect(removed.length).toBe(3);
    for (const destination of removed) {
      expect(destination.verification?.checked).toContain("ya no existe");
      expect(destination.verification?.passed).toBe(true);
    }
  });

  it("una operación interrumpida se detecta al reabrir y se puede restaurar", async () => {
    const dir = await makeSkillDir(root, "pdf", "instalada");
    await install(ctx, dir);
    const canonical = join(canonicalSkillsRoot(home), "pdf");

    // Lo que una interrupción deja: la canónica movida a su respaldo y el
    // journal describiendo el destino como aplicado.
    const backupDir = join(home, ".agents", ".workline-skills", "op-1", "backup");
    await mkdir(backupDir, { recursive: true });
    const { rename } = await import("node:fs/promises");
    await rename(canonical, join(backupDir, "pdf"));
    await writeFile(
      skillsJournalPath(home),
      JSON.stringify({
        id: "op-1",
        operation: "update",
        approvedDigest: "sellado",
        owner: { pid: 1, ts: "2026-09-09T00:00:00.000Z" },
        destinations: [
          {
            location: canonical,
            host: "agents",
            action: "replace",
            status: "applied",
            backup: join(backupDir, "pdf"),
          },
        ],
        registryBefore: (await readSkillsRegistry(ctx)).registry,
        registryWritten: false,
      }),
      "utf8",
    );

    // Aplicar encima está prohibido: repetiría efectos a ciegas.
    const blocked = await prepareSkillChange(ctx, { operation: "install", source: dir });
    if (blocked.status !== "prepared") throw new Error(`estado ${blocked.status}`);
    try {
      const outcome = await applySkillChange(ctx, blocked.proposal, blocked.proposal.digest);
      expect(outcome.status).toBe("refused");
      if (outcome.status === "refused") expect(outcome.refusal.code).toBe("JOURNAL_PENDING");
    } finally {
      await blocked.release();
    }

    const recovered = await recoverSkillJournal(ctx, "restore");
    if (recovered.status !== "applied") throw new Error("no restauró");
    expect(recovered.result.recovery?.pending).toEqual([]);
    expect(await readFile(join(canonical, "SKILL.md"), "utf8")).toContain("instalada");
    expect(await readSkillJournal(ctx)).toBeNull();
  });

  it("una restauración que no puede completarse declara el estado mixto y conserva el journal", async () => {
    const dir = await makeSkillDir(root, "pdf", "instalada");
    await install(ctx, dir);
    const canonical = join(canonicalSkillsRoot(home), "pdf");

    // Lo que deja una interrupción cuyo respaldo ya no está: restaurar no
    // puede terminar, y eso no se puede reportar como restaurado.
    await writeFile(
      skillsJournalPath(home),
      JSON.stringify({
        id: "op-3",
        operation: "update",
        approvedDigest: "sellado",
        owner: { pid: 1, ts: "2026-09-09T00:00:00.000Z" },
        destinations: [
          {
            location: canonical,
            host: "agents",
            action: "replace",
            status: "applied",
            backup: join(home, ".agents", ".workline-skills", "op-3", "backup", "pdf"),
          },
        ],
        registryBefore: (await readSkillsRegistry(ctx)).registry,
        registryWritten: false,
      }),
      "utf8",
    );

    const outcome = await recoverSkillJournal(ctx, "restore");

    if (outcome.status !== "applied") throw new Error("no devolvió resultado");
    expect(outcome.result.recovery?.pending).toEqual([canonical]);
    expect(outcome.result.recovery?.action).toContain("estado mixto");
    expect(outcome.result.destinations[0]?.status).toBe("failed");
    // El journal se conserva: queda algo por resolver.
    expect(await readSkillJournal(ctx)).not.toBeNull();
  });

  it("aceptar el estado actual descarta el journal sin repetir ningún efecto", async () => {
    const dir = await makeSkillDir(root, "pdf");
    await install(ctx, dir);
    await writeFile(
      skillsJournalPath(home),
      JSON.stringify({
        id: "op-2",
        operation: "repair",
        approvedDigest: "sellado",
        owner: { pid: 1, ts: "2026-09-09T00:00:00.000Z" },
        destinations: [],
        registryBefore: (await readSkillsRegistry(ctx)).registry,
        registryWritten: false,
      }),
      "utf8",
    );

    const outcome = await recoverSkillJournal(ctx, "discard");

    expect(outcome.status).toBe("applied");
    expect(await readSkillJournal(ctx)).toBeNull();
    // La instalación sigue como estaba: descartar no aplica ni revierte nada.
    expect(existsSync(join(canonicalSkillsRoot(home), "pdf", "SKILL.md"))).toBe(true);
  });

  it("el registro también se comprueba: es uno de los destinos, no una nota al pie", async () => {
    const dir = await makeSkillDir(root, "pdf");

    const result = await install(ctx, dir);

    const registry = result.destinations.find((d) => d.host === "registry");
    expect(registry?.status).toBe("applied");
    expect(registry?.verification?.checked).toContain("entradas del registro");
    expect(registry?.verification?.passed).toBe(true);
  });

  it("los respaldos y el staging viven FUERA de las raíces que el host escanea", async () => {
    const dir = await makeSkillDir(root, "pdf", "v1");
    await install(ctx, dir);
    await makeSkillDir(root, "pdf", "v2");

    await applyChange(ctx, { operation: "install", source: dir });

    // Nada con forma de skill quedó dentro de las raíces administradas salvo
    // la propia skill: ni staging, ni backup, ni un dot-dir escaneable.
    for (const scanned of [
      canonicalSkillsRoot(home),
      claudeReplicaRoot(home),
      geminiReplicaRoot(home),
    ]) {
      const list = await ctx.fs.list(scanned);
      expect(list.map((entry) => entry.name)).toEqual(["pdf"]);
    }
    expect(await readFile(join(canonicalSkillsRoot(home), "pdf", "SKILL.md"), "utf8")).toContain(
      "v2",
    );
  });
});

describe("listSkills — inventario completo del ancla", () => {
  let root: string;
  let home: string;
  let ctx: CliContext;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "aw-skills-list-"));
    home = join(root, "home");
    await mkdir(home, { recursive: true });
    ctx = buildCtx(home);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("listSkills ordena installed → unmanaged → registered → recommended, alfabético por grupo", async () => {
    const seed = [
      { name: "zeta-rec", source: "a/b", description: "z" },
      { name: "alfa-rec", source: "a/b", description: "a" },
    ];
    const inst = await makeSkillDir(root, "instalada");
    const reg = await makeSkillDir(root, "solo-registrada");
    await install(ctx, inst);
    await applyChange(ctx, { operation: "register", source: reg });
    // Foreign canonical dir (outside the registry), e.g. installed by skills.sh.
    await makeSkillDir(canonicalSkillsRoot(home), "fuera-registro");

    const list = await listSkills(ctx, seed);

    expect(list.map((s) => `${s.name}:${s.status}`)).toEqual([
      "instalada:installed",
      "fuera-registro:unmanaged",
      "solo-registrada:registered",
      "alfa-rec:recommended",
      "zeta-rec:recommended",
    ]);
    expect(list[0]?.replicas).toEqual({ agents: true, claude: true, gemini: true });
    expect(list[1]?.replicas).toEqual({ agents: true, claude: false, gemini: false });
    expect(list[2]?.replicas).toEqual({ agents: false, claude: false, gemini: false });
  });

  it("unmanaged: fuente desde el lock de skills.sh, ruido ignorado y sin fila recommended duplicada", async () => {
    const canonRoot = canonicalSkillsRoot(home);
    await makeSkillDir(canonRoot, "con-lock");
    await makeSkillDir(canonRoot, "sin-lock");
    // Noise the scan must NOT list: dot-dir, dir without SKILL.md, loose file.
    await mkdir(join(canonRoot, ".staging-x"), { recursive: true });
    await mkdir(join(canonRoot, "sin-skill-md"), { recursive: true });
    await writeFile(join(canonRoot, "suelto.txt"), "x", "utf8");
    await writeFile(
      join(home, ".agents", ".skill-lock.json"),
      JSON.stringify({ skills: { "con-lock": { source: "softaworks/agent-toolkit" } } }),
      "utf8",
    );

    // The bundle and its namespace are NOT "someone else's" ([Workline] manages them).
    await makeSkillDir(canonRoot, "w");
    await makeSkillDir(canonRoot, "w-plan-exec-loop");
    await makeSkillDir(canonRoot, "agent-workflow");
    // Name inherited from Object.prototype: requires hasOwn, not truthiness.
    await makeSkillDir(canonRoot, "constructor");

    // Same-named seed: the unmanaged row wins and is not duplicated as recommended.
    const seed = [{ name: "con-lock", source: "a/b", description: "homónima" }];
    const list = await listSkills(ctx, seed);

    expect(list.map((s) => `${s.name}:${s.status}`).sort()).toEqual([
      "con-lock:unmanaged",
      "constructor:unmanaged",
      "sin-lock:unmanaged",
    ]);
    const byName = new Map(list.map((s) => [s.name, s]));
    expect(byName.get("con-lock")?.source).toBe("softaworks/agent-toolkit");
    expect(byName.get("sin-lock")?.source).toBe("");
  });

  it("gate 016: registro corrupto apaga el scan; symlink-a-dir se lista; semilla con canónica inválida no ofrece Install", async () => {
    const canonRoot = canonicalSkillsRoot(home);
    // Dev checkout linked to the anchor: hosts follow it, the tab must see it.
    const real = await makeSkillDir(root, "linked-real");
    await mkdir(canonRoot, { recursive: true });
    await symlink(real, join(canonRoot, "linkeada"));
    // Canonical dir named like a seed but WITHOUT valid frontmatter: offering
    // Install would guarantee SKILL_NAME_COLLISION → the seed is hidden.
    await mkdir(join(canonRoot, "pdf"), { recursive: true });
    await writeFile(join(canonRoot, "pdf", "SKILL.md"), "sin frontmatter", "utf8");

    const seed = [{ name: "pdf", source: "anthropics/skills", description: "d" }];
    let list = await listSkills(ctx, seed);
    expect(list.map((s) => `${s.name}:${s.status}`)).toEqual(["linkeada:unmanaged"]);

    // Unreadable registry: nothing gets classified unmanaged (it could be the
    // engine's) and the list does not blow up.
    await mkdir(join(home, ".agents"), { recursive: true });
    await writeFile(join(home, ".agents", ".skills-registry.json"), "{roto", "utf8");
    list = await listSkills(ctx, seed);
    expect(list).toEqual([]);
  });
});

// ===== Spec 043 — la proyección lleva la curación, sin confundirla con el estado =====

describe("listSkills — proyección de la curación (Spec 043)", () => {
  let root: string;
  let home: string;
  let ctx: CliContext;

  /** Catálogo mínimo con los cuatro casos que la spec fija. */
  const catalog = [
    {
      name: "ponytail",
      source: "DietrichGebert/ponytail",
      description: "modo perezoso",
      disposition: "withdrawn" as const,
      reason: "duplica la minimalidad del chassis",
    },
    {
      name: "condition-based-waiting",
      source: "nickcrew/claude-ctx-plugin",
      description: "espera por condición",
      disposition: "repair" as const,
      reason: "la instalación viene de otra obra",
      useWhen: "reemplazar un sleep() adivinado",
      proposedSource: "NickCrew/Claude-Cortex",
      reviewedRef: "bb47af79ad3befe01ae01940fcf5f16e30a1b6df",
    },
    {
      name: "react-best-practices",
      source: "vercel-labs/agent-skills",
      description: "reglas de React",
      disposition: "conditional" as const,
      useWhen: "reglas de React web aplicables",
      skillName: "vercel-react-best-practices",
    },
    {
      name: "pdf",
      source: "anthropics/skills",
      description: "PDF",
      disposition: "conditional" as const,
      useWhen: "PDF pedido o presente",
    },
  ];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "aw-skills-curation-"));
    home = join(root, "home");
    await mkdir(home, { recursive: true });
    ctx = buildCtx(home);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("una retirada instalada sigue en la lista con su motivo y NO vuelve como recomendada", async () => {
    // Sin instalación, una retirada no produce fila: dejar de recomendar es
    // dejar de ofrecer.
    expect((await listSkills(ctx, catalog)).map((s) => s.name)).not.toContain("ponytail");

    const dir = await makeSkillDir(root, "ponytail");
    await install(ctx, dir);

    // Instalada, la fila la emite el REGISTRO y el catálogo le presta su motivo.
    const item = (await listSkills(ctx, catalog)).find((s) => s.name === "ponytail");
    expect(item?.status).toBe("installed");
    expect(item?.curation).toMatchObject({
      disposition: "withdrawn",
      reason: "duplica la minimalidad del chassis",
    });
    expect(item?.description).toBe("modo perezoso");
  });

  it("un origen divergente se muestra como propuesta, sin migrar la fuente registrada", async () => {
    const dir = await makeSkillDir(root, "condition-based-waiting");
    await applyChange(ctx, { operation: "register", source: dir });

    const item = (await listSkills(ctx, catalog)).find((s) => s.name === "condition-based-waiting");

    expect(item?.status).toBe("registered");
    // La fuente de la fila sigue siendo la registrada; la propuesta viaja aparte.
    expect(item?.source).toBe(dir);
    expect(item?.curation?.proposedSource).toBe("NickCrew/Claude-Cortex");
    expect(item?.curation?.reviewedRef).toBe("bb47af79ad3befe01ae01940fcf5f16e30a1b6df");
    const { registry } = await readSkillsRegistry(ctx);
    expect(registry.skills["condition-based-waiting"]?.source).toBe(dir);
  });

  it("un alias de catálogo conserva su identidad invocable en la proyección", async () => {
    const item = (await listSkills(ctx, catalog)).find((s) => s.name === "react-best-practices");

    expect(item?.status).toBe("recommended");
    expect(item?.curation?.skillName).toBe("vercel-react-best-practices");
  });

  it("una instalación que el catálogo no revisó no toma prestado ningún veredicto", async () => {
    await makeSkillDir(canonicalSkillsRoot(home), "cloudflare");

    const item = (await listSkills(ctx, catalog)).find((s) => s.name === "cloudflare");

    expect(item?.status).toBe("unmanaged");
    expect(item?.curation).toBeUndefined();
    expect(item?.description).toBeUndefined();
  });

  it("consultar la lista no invoca ninguna mutación (ni con el catálogo entero)", async () => {
    const dir = await makeSkillDir(root, "pdf");
    await applyChange(ctx, { operation: "register", source: dir });
    await makeSkillDir(canonicalSkillsRoot(home), "ajena");

    // Un adaptador que estalla en cada escritura: si la proyección tocara algo,
    // esta llamada fallaría en vez de devolver filas.
    const list = await listSkills(buildCtx(home, new WriteProofFs()), catalog);

    expect(list.map((s) => s.name).sort()).toEqual([
      "ajena",
      "condition-based-waiting",
      "pdf",
      "react-best-practices",
    ]);
    expect(existsSync(join(canonicalSkillsRoot(home), "pdf"))).toBe(false);
  });
});
