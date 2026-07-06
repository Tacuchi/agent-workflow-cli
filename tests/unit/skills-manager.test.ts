import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import {
  REPLICA_MARKER_FILENAME,
  canonicalSkillsRoot,
  claudeReplicaRoot,
  geminiReplicaRoot,
  installSkill,
  listSkills,
  materializeCanonical,
  probeSkillSource,
  registerSkill,
  reinstallSkill,
  removeSkill,
  resolveSkillSource,
  uninstallSkill,
  updateSkill,
} from "../../src/application/self/skills-manager.js";
import { readSkillsRegistry } from "../../src/application/self/skills-registry.js";
import type { CliContext } from "../../src/cli/types.js";
import { FakeEnv } from "../helpers/fake-env.js";

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

describe("skills-manager (T3.3-T3.7)", () => {
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

  it("register desde path local con varias skills pide cherry-pick y registra la elegida", async () => {
    const source = join(root, "container");
    await mkdir(join(source, "skills"), { recursive: true });
    await makeSkillDir(join(source, "skills"), "pdf");
    await makeSkillDir(join(source, "skills"), "docx");

    const needsPick = await registerSkill(ctx, { source });
    expect(needsPick.ok).toBe(true);
    expect(needsPick.data?.status).toBe("needs-pick");
    expect(needsPick.data?.candidates).toEqual(["docx", "pdf"]);

    const registered = await registerSkill(ctx, { source, pick: "pdf" });
    expect(registered.ok).toBe(true);
    expect(registered.data?.status).toBe("registered");
    const { registry } = await readSkillsRegistry(ctx);
    expect(registry.skills.pdf?.source).toBe(source);
    expect(registry.skills.docx).toBeUndefined();
  });

  it("register de un dir que ES una skill registra directo con el nombre del dir", async () => {
    const dir = await makeSkillDir(root, "mi-skill");
    const result = await registerSkill(ctx, { source: dir });
    expect(result.ok).toBe(true);
    expect(result.data?.name).toBe("mi-skill");
  });

  it("register duplicado y colisión con dir canónico ajeno fallan con error claro", async () => {
    const dir = await makeSkillDir(root, "pdf");
    await registerSkill(ctx, { source: dir });
    const dup = await registerSkill(ctx, { source: dir });
    expect(dup.ok).toBe(false);
    expect(dup.error?.code).toBe("SKILL_ALREADY_REGISTERED");

    // Existing canonical dir NOT in the registry (e.g. the `w` bundle) → collision.
    await mkdir(join(canonicalSkillsRoot(home), "w"), { recursive: true });
    const wDir = await makeSkillDir(join(root, "otra"), "w");
    const collision = await registerSkill(ctx, { source: wDir });
    expect(collision.ok).toBe(false);
    expect(collision.error?.code).toBe("SKILL_NAME_COLLISION");
  });

  it("register rechaza el prefijo reservado w- (namespace de wrappers del bundle)", async () => {
    const dir = await makeSkillDir(root, "w-scraper");
    const result = await registerSkill(ctx, { source: dir });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("RESERVED_SKILL_PREFIX");
  });

  it("install materializa canónica + symlink a Claude y persiste mode/installedAt", async () => {
    const dir = await makeSkillDir(root, "pdf");
    await registerSkill(ctx, { source: dir });

    const result = await installSkill(ctx, "pdf");

    expect(result.ok).toBe(true);
    const canonical = join(canonicalSkillsRoot(home), "pdf");
    const replica = join(claudeReplicaRoot(home), "pdf");
    expect(existsSync(join(canonical, "SKILL.md"))).toBe(true);
    expect((await ctx.fs.lstat(replica))?.isSymlink).toBe(true);
    expect(await readFile(join(replica, "SKILL.md"), "utf8")).toContain("v1");
    const { registry } = await readSkillsRegistry(ctx);
    expect(registry.skills.pdf?.mode).toBe("symlink");
    expect(registry.skills.pdf?.installedAt).toBeDefined();
  });

  it("sin symlink disponible cae a copia y registra mode=copy (AC4)", async () => {
    const noLinkCtx = buildCtx(home, new NoSymlinkFs());
    const dir = await makeSkillDir(root, "pdf");
    await registerSkill(noLinkCtx, { source: dir });

    const result = await installSkill(noLinkCtx, "pdf");

    expect(result.ok).toBe(true);
    expect(result.data?.mode).toBe("copy");
    const replica = join(claudeReplicaRoot(home), "pdf");
    const stat = await new NodeFileSystem().lstat(replica);
    expect(stat).toEqual({ type: "dir", isSymlink: false });
    const { registry } = await readSkillsRegistry(noLinkCtx);
    expect(registry.skills.pdf?.mode).toBe("copy");
  });

  it("install rehúsa pisar una réplica ajena en ~/.claude/skills (guard)", async () => {
    const dir = await makeSkillDir(root, "pdf");
    await registerSkill(ctx, { source: dir });
    // Foreign replica: a real dir this manager did not create.
    await makeSkillDir(claudeReplicaRoot(home), "pdf");

    const result = await installSkill(ctx, "pdf");

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("FOREIGN_REPLICA");
    expect(existsSync(join(claudeReplicaRoot(home), "pdf", "SKILL.md"))).toBe(true);
  });

  it("réplica gemini: install crea COPY con marker en ~/.gemini/skills (agy no lee el ancla ni se garantiza que siga symlinks)", async () => {
    const dir = await makeSkillDir(root, "pdf");
    await registerSkill(ctx, { source: dir });

    const result = await installSkill(ctx, "pdf");

    expect(result.ok).toBe(true);
    const gemini = join(geminiReplicaRoot(home), "pdf");
    const stat = await ctx.fs.lstat(gemini);
    expect(stat).toEqual({ type: "dir", isSymlink: false }); // copy, not a symlink
    expect(existsSync(join(gemini, "SKILL.md"))).toBe(true);
    expect(existsSync(join(gemini, REPLICA_MARKER_FILENAME))).toBe(true);
    // The registered mode is still the Claude replica's (symlink): the "(copy)"
    // badge is reserved for ITS degradation, not for the by-design copy.
    const { registry } = await readSkillsRegistry(ctx);
    expect(registry.skills.pdf?.mode).toBe("symlink");
    expect(result.data?.replicas).toEqual([
      { host: "claude", path: join(claudeReplicaRoot(home), "pdf"), mode: "symlink" },
      { host: "gemini", path: gemini, mode: "copy" },
    ]);
  });

  it("réplica gemini: dir ajeno homónimo (sin marker) bloquea el install y se preserva", async () => {
    const dir = await makeSkillDir(root, "pdf");
    await registerSkill(ctx, { source: dir });
    await makeSkillDir(geminiReplicaRoot(home), "pdf");

    const result = await installSkill(ctx, "pdf");

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("FOREIGN_REPLICA");
    expect(existsSync(join(geminiReplicaRoot(home), "pdf", "SKILL.md"))).toBe(true);
    // Nothing was half-materialized.
    expect(existsSync(join(claudeReplicaRoot(home), "pdf"))).toBe(false);
  });

  it("uninstall desmonta también la réplica gemini (marker la autentica)", async () => {
    const dir = await makeSkillDir(root, "pdf");
    await registerSkill(ctx, { source: dir });
    await installSkill(ctx, "pdf");
    const gemini = join(geminiReplicaRoot(home), "pdf");
    expect(existsSync(gemini)).toBe(true);

    const result = await uninstallSkill(ctx, "pdf");

    expect(result.ok).toBe(true);
    expect(existsSync(gemini)).toBe(false);
    expect(existsSync(join(claudeReplicaRoot(home), "pdf"))).toBe(false);
  });

  it("update re-fetchea el repo git registrado (staging+swap) y refleja el nuevo contenido", async () => {
    const repo = await makeGitSource(root, ["pdf"]);
    await registerSkill(ctx, { source: `file://${repo}`, pick: "pdf" });
    await installSkill(ctx, "pdf");

    await writeFile(
      join(repo, "skills", "pdf", "SKILL.md"),
      "---\nname: pdf\ndescription: test skill pdf\n---\nv2\n",
      "utf8",
    );
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "v2");

    const result = await updateSkill(ctx, "pdf");

    expect(result.ok).toBe(true);
    expect(result.data?.status).toBe("updated");
    const canonical = join(canonicalSkillsRoot(home), "pdf");
    expect(await readFile(join(canonical, "SKILL.md"), "utf8")).toContain("v2");
    // The symlink replica points at the canonical dir → it also sees v2.
    expect(await readFile(join(claudeReplicaRoot(home), "pdf", "SKILL.md"), "utf8")).toContain(
      "v2",
    );
  });

  it("update fallido (fuente desaparecida) deja la instalación previa intacta", async () => {
    const repo = await makeGitSource(root, ["pdf"]);
    await registerSkill(ctx, { source: `file://${repo}`, pick: "pdf" });
    await installSkill(ctx, "pdf");
    await rm(repo, { recursive: true, force: true });

    const result = await updateSkill(ctx, "pdf");

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("FETCH_FAILED");
    const canonical = join(canonicalSkillsRoot(home), "pdf");
    expect(await readFile(join(canonical, "SKILL.md"), "utf8")).toContain("v1");
  });

  it("update sobre fuente de path local rehúsa (UPDATE_REQUIRES_GIT)", async () => {
    const dir = await makeSkillDir(root, "pdf");
    await registerSkill(ctx, { source: dir });
    await installSkill(ctx, "pdf");

    const result = await updateSkill(ctx, "pdf");

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("UPDATE_REQUIRES_GIT");
  });

  it("reinstall repara la réplica desde la canónica sin tocar la fuente (offline)", async () => {
    const dir = await makeSkillDir(root, "pdf");
    await registerSkill(ctx, { source: dir });
    await installSkill(ctx, "pdf");
    await rm(dir, { recursive: true, force: true }); // source no longer exists
    await ctx.fs.remove(join(claudeReplicaRoot(home), "pdf")); // broken replica

    const result = await reinstallSkill(ctx, "pdf");

    expect(result.ok).toBe(true);
    expect(result.data?.status).toBe("reinstalled");
    expect((await ctx.fs.lstat(join(claudeReplicaRoot(home), "pdf")))?.isSymlink).toBe(true);
  });

  it("uninstall borra canónica y réplica pero conserva el registro (queda registered)", async () => {
    const dir = await makeSkillDir(root, "pdf");
    await registerSkill(ctx, { source: dir });
    await installSkill(ctx, "pdf");

    const result = await uninstallSkill(ctx, "pdf");

    expect(result.ok).toBe(true);
    expect(existsSync(join(canonicalSkillsRoot(home), "pdf"))).toBe(false);
    expect(await ctx.fs.lstat(join(claudeReplicaRoot(home), "pdf"))).toBeNull();
    const { registry } = await readSkillsRegistry(ctx);
    expect(registry.skills.pdf?.source).toBe(dir);
    expect(registry.skills.pdf?.mode).toBeUndefined();
    expect(registry.skills.pdf?.installedAt).toBeUndefined();
  });

  it("remove además quita la entrada; una recomendada vuelve a 'recommended' en la lista (AC6)", async () => {
    const dir = await makeSkillDir(root, "pdf");
    const seed = [{ name: "pdf", source: "anthropics/skills", description: "PDF tooling" }];
    await registerSkill(ctx, { source: dir });
    await installSkill(ctx, "pdf");

    const result = await removeSkill(ctx, "pdf");

    expect(result.ok).toBe(true);
    const { registry } = await readSkillsRegistry(ctx);
    expect(registry.skills.pdf).toBeUndefined();
    const list = await listSkills(ctx, seed);
    expect(list).toHaveLength(1);
    expect(list[0]?.status).toBe("recommended");
  });

  it("operaciones sobre nombres no registrados rehúsan (guard de ownership, T3.7)", async () => {
    for (const op of [installSkill, updateSkill, uninstallSkill, removeSkill] as const) {
      const result = await op(ctx, "w");
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("SKILL_NOT_REGISTERED");
    }
    expect(existsSync(join(canonicalSkillsRoot(home), "w"))).toBe(false);
  });

  it("probeSkillSource lista candidatos sin registrar nada (para el wizard)", async () => {
    const source = join(root, "container");
    await makeSkillDir(join(source, "skills"), "pdf");
    await makeSkillDir(join(source, "skills"), "docx");

    const probe = await probeSkillSource(ctx, { source });

    expect(probe.ok).toBe(true);
    expect(probe.data?.candidates).toEqual(["docx", "pdf"]);
    const { registry } = await readSkillsRegistry(ctx);
    expect(Object.keys(registry.skills)).toEqual([]);
  });

  it("repo git con SKILL.md en la raíz se registra por su frontmatter name (nunca el tempdir) e instala", async () => {
    const repo = join(root, "single-skill-repo");
    await mkdir(repo, { recursive: true });
    await writeFile(
      join(repo, "SKILL.md"),
      "---\nname: root-skill\ndescription: single skill at repo root\n---\nv1\n",
      "utf8",
    );
    git(repo, "init", "-b", "main");
    git(repo, "config", "user.email", "test@test");
    git(repo, "config", "user.name", "test");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "v1");

    const registered = await registerSkill(ctx, { source: `file://${repo}` });
    expect(registered.ok).toBe(true);
    expect(registered.data?.name).toBe("root-skill");

    const installed = await installSkill(ctx, "root-skill");
    expect(installed.ok).toBe(true);
    expect(existsSync(join(canonicalSkillsRoot(home), "root-skill", "SKILL.md"))).toBe(true);
  });

  it("encuentra skills anidadas skills/<categoría>/<skill> (layout mattpocock/skills)", async () => {
    const source = join(root, "nested");
    await makeSkillDir(join(source, "skills", "engineering"), "diagnosing-bugs");
    await makeSkillDir(join(source, "skills", "productivity"), "writing-great-skills");

    const needsPick = await registerSkill(ctx, { source });
    expect(needsPick.data?.candidates).toEqual(["diagnosing-bugs", "writing-great-skills"]);

    const registered = await registerSkill(ctx, { source, pick: "diagnosing-bugs" });
    expect(registered.ok).toBe(true);
    const installed = await installSkill(ctx, "diagnosing-bugs");
    expect(installed.ok).toBe(true);
  });

  it("descubre skills en el layout canónico .claude/skills/<skill> (repo estilo erichowens), sin listar otros dot-dirs", async () => {
    const source = join(root, "dot-claude");
    await makeSkillDir(join(source, ".claude", "skills"), "checklist-discipline");
    // Other dot-dirs stay noise: `.git`, `.github/skills`, editor state, etc.
    await makeSkillDir(join(source, ".github", "skills"), "should-not-appear");

    const probe = await probeSkillSource(ctx, { source });
    expect(probe.ok).toBe(true);
    expect(probe.data?.candidates).toEqual(["checklist-discipline"]);

    const registered = await registerSkill(ctx, { source, pick: "checklist-discipline" });
    expect(registered.ok).toBe(true);
    const installed = await installSkill(ctx, "checklist-discipline");
    expect(installed.ok).toBe(true);
    expect(existsSync(join(canonicalSkillsRoot(home), "checklist-discipline", "SKILL.md"))).toBe(
      true,
    );
  });

  it("git manifest-only: install materializa el dir completo con assets bundleados (references/), no solo el SKILL.md", async () => {
    const repo = join(root, "assets-repo");
    const skillDir = join(repo, ".claude", "skills", "checklist-discipline");
    await mkdir(join(skillDir, "references"), { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\nname: checklist-discipline\ndescription: d\n---\nbody\n",
      "utf8",
    );
    await writeFile(join(skillDir, "references", "note.md"), "bundled asset\n", "utf8");
    // Unrelated bulk the manifest-only discovery must never need.
    await writeFile(join(repo, "huge.bin"), "X".repeat(200000), "utf8");
    git(repo, "init", "-b", "main");
    git(repo, "config", "user.email", "test@test");
    git(repo, "config", "user.name", "test");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "v1");

    const registered = await registerSkill(ctx, {
      source: `file://${repo}`,
      pick: "checklist-discipline",
    });
    expect(registered.ok).toBe(true);
    const installed = await installSkill(ctx, "checklist-discipline");
    expect(installed.ok).toBe(true);
    const canonical = join(canonicalSkillsRoot(home), "checklist-discipline");
    expect(existsSync(join(canonical, "SKILL.md"))).toBe(true);
    // The sparse expansion must pull the WHOLE skill dir, not just the manifest.
    expect(await readFile(join(canonical, "references", "note.md"), "utf8")).toContain(
      "bundled asset",
    );
  });

  it("registro corrupto aborta toda mutación y el archivo queda intacto (nunca se pisa)", async () => {
    const dir = await makeSkillDir(root, "pdf");
    await registerSkill(ctx, { source: dir });
    const registryPath = join(home, ".agents", ".skills-registry.json");
    const corrupt = '{ "skills": { "pdf": { "source": "x", }, }';
    await writeFile(registryPath, corrupt, "utf8");

    const otherDir = await makeSkillDir(root, "docx");
    for (const attempt of [
      () => registerSkill(ctx, { source: otherDir }),
      () => installSkill(ctx, "pdf"),
      () => uninstallSkill(ctx, "pdf"),
      () => removeSkill(ctx, "pdf"),
    ]) {
      const result = await attempt();
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("REGISTRY_UNREADABLE");
    }
    expect(await readFile(registryPath, "utf8")).toBe(corrupt);
  });

  it("un symlink del usuario hacia OTRO lado es ajeno: install/update abortan sin mutar nada", async () => {
    const repo = await makeGitSource(root, ["pdf"]);
    await registerSkill(ctx, { source: `file://${repo}`, pick: "pdf" });
    await installSkill(ctx, "pdf");
    // The user replaces the replica with THEIR OWN symlink to their dotfiles.
    const userSkill = await makeSkillDir(root, "dotfiles-pdf");
    const replica = join(claudeReplicaRoot(home), "pdf");
    await ctx.fs.remove(replica);
    await new NodeFileSystem().symlink(userSkill, replica);
    // The source advances to v2.
    await writeFile(
      join(repo, "skills", "pdf", "SKILL.md"),
      "---\nname: pdf\ndescription: test skill pdf\n---\nv2\n",
      "utf8",
    );
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "v2");

    const result = await updateSkill(ctx, "pdf");

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("FOREIGN_REPLICA");
    // Neither did the canonical dir update (pre-flight before materializing)…
    const canonical = join(canonicalSkillsRoot(home), "pdf");
    expect(await readFile(join(canonical, "SKILL.md"), "utf8")).toContain("v1");
    // …nor was the user's symlink re-pointed.
    expect(await readFile(join(replica, "SKILL.md"), "utf8")).toContain("dotfiles-pdf");
  });

  it("canónica ajena bajo un nombre registrado-sin-instalar: install rehúsa y remove la conserva", async () => {
    const dir = await makeSkillDir(root, "docx");
    await registerSkill(ctx, { source: dir }); // registered, never installed
    // Another actor (plugin, manual install) creates the same-named canonical dir.
    await makeSkillDir(canonicalSkillsRoot(home), "docx");

    const install = await installSkill(ctx, "docx");
    expect(install.ok).toBe(false);
    expect(install.error?.code).toBe("SKILL_NAME_COLLISION");

    const remove = await removeSkill(ctx, "docx");
    expect(remove.ok).toBe(true);
    expect(remove.data?.warning).toContain("no lo materializó");
    expect(existsSync(join(canonicalSkillsRoot(home), "docx", "SKILL.md"))).toBe(true);
  });

  it("materializar nunca sigue symlinks de la fuente (repo hostil no exfiltra archivos)", async () => {
    const secret = join(root, "secret.txt");
    await writeFile(secret, "MUY-SECRETO", "utf8");
    const dir = await makeSkillDir(root, "pdf");
    await new NodeFileSystem().symlink(secret, join(dir, "notes"));
    await registerSkill(ctx, { source: dir });

    const result = await installSkill(ctx, "pdf");

    expect(result.ok).toBe(true);
    const canonical = join(canonicalSkillsRoot(home), "pdf");
    expect(existsSync(join(canonical, "SKILL.md"))).toBe(true);
    expect(existsSync(join(canonical, "notes"))).toBe(false);
  });

  it("swap fallido restaura la canónica previa (rama .bak de materializeCanonical)", async () => {
    const v1 = await makeSkillDir(join(root, "v1"), "pdf");
    const v2 = await makeSkillDir(join(root, "v2"), "pdf", "v2");
    await registerSkill(ctx, { source: v1 });
    await installSkill(ctx, "pdf");
    const canonical = join(canonicalSkillsRoot(home), "pdf");

    let calls = 0;
    const failingRename: typeof rename = async (from, to) => {
      calls += 1;
      if (calls === 2) throw new Error("boom en el swap");
      return rename(from, to);
    };
    await expect(materializeCanonical(ctx, v2, canonical, "pdf", failingRename)).rejects.toThrow(
      "boom",
    );

    expect(await readFile(join(canonical, "SKILL.md"), "utf8")).toContain("v1");
  });

  it("listSkills ordena installed → unmanaged → registered → recommended, alfabético por grupo", async () => {
    const seed = [
      { name: "zeta-rec", source: "a/b", description: "z" },
      { name: "alfa-rec", source: "a/b", description: "a" },
    ];
    const inst = await makeSkillDir(root, "instalada");
    const reg = await makeSkillDir(root, "solo-registrada");
    await registerSkill(ctx, { source: inst });
    await installSkill(ctx, "instalada");
    await registerSkill(ctx, { source: reg });
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

    // The bundle and its namespace are NOT "someone else's" ([Workflows] manages them).
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
