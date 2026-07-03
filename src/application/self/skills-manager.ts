// Motor de skills sueltas (modelo skills.sh): canónica en ~/.agents/skills/<n>
// (el ancla del estándar abierto que escanean los hosts no-Claude) + réplica en
// ~/.claude/skills/<n> vía symlink, con fallback a copia (Windows sin links).
//
// El registro user-level (skills-registry.ts) es la fuente de verdad de QUÉ
// administra este motor. Guards de ownership (el motor escribe bajo el HOME
// real del usuario, donde también viven el bundle `w`, skills de plugins y
// skills manuales):
//   - toda operación exige nombre registrado (SKILL_NOT_REGISTERED);
//   - la canónica solo se crea/borra si este motor la materializó — señal:
//     `installedAt` en el registro (SKILL_NAME_COLLISION al chocar con un dir
//     ajeno; en uninstall/remove el dir ajeno se conserva con warning);
//   - la réplica de Claude es nuestra solo si es un symlink QUE APUNTA a la
//     canónica o un dir con mode:"copy" registrado (FOREIGN_REPLICA si no), y
//     se verifica ANTES de mutar nada;
//   - un registro ilegible (warning del read) aborta toda mutación: jamás se
//     reescribe por encima de entradas que no se pudieron leer.

import type { Dirent } from "node:fs";
import { readFile, readdir, readlink, rename } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { CliContext } from "../../cli/types.js";
import type { CommandResult } from "../../domain/types.js";
import { gitClone } from "./install-plugin-skills-git.js";
import { copyDir, hasValidFrontmatter } from "./install-plugin-skills.js";
import {
  type SkillRegistryEntry,
  type SkillReplicaMode,
  type SkillsRegistry,
  isValidSkillName,
  readSkillsRegistry,
  writeSkillsRegistry,
} from "./skills-registry.js";

export type SkillStatus = "installed" | "registered" | "recommended";

/** Semilla de recomendadas — la define el data module de la TUI y entra por parámetro
 *  (application no importa de cli/). */
export interface SeedSkill {
  name: string;
  source: string;
  description: string;
}

export interface SkillListItem {
  name: string;
  source: string;
  ref?: string;
  mode?: SkillReplicaMode;
  installedAt?: string;
  description?: string;
  status: SkillStatus;
  /** Réplicas materializadas: ancla .agents (canónica) y .claude. */
  replicas: { agents: boolean; claude: boolean };
}

export interface RegisterInput {
  /** `owner/repo`, URL git (con `#ref` opcional) o path local absoluto. */
  source: string;
  ref?: string;
  /** Nombre del skill-dir a registrar cuando la fuente contiene varios. */
  pick?: string;
}

export interface RegisterData {
  status: "registered" | "needs-pick";
  name?: string;
  entry?: SkillRegistryEntry;
  /** Candidatos cuando la fuente trae >1 skill y no hubo `pick`. */
  candidates?: string[];
  summary: string;
}

export interface MaterializeData {
  status: "installed" | "updated" | "reinstalled";
  name: string;
  canonical: string;
  replica: string;
  mode: SkillReplicaMode;
  summary: string;
}

export interface UninstallData {
  status: "uninstalled" | "removed";
  name: string;
  /** Presente si algo ajeno homónimo se conservó (canónica o réplica). */
  warning?: string;
  summary: string;
}

type ResolvedSource = { kind: "git"; url: string; ref?: string } | { kind: "local"; path: string };

type SkillCandidate = { name: string; path: string };

// skills/<categoría>/<skill> (mattpocock/skills) cabe en 3 niveles bajo la raíz.
const MAX_SCAN_DEPTH = 3;

export function canonicalSkillsRoot(home: string): string {
  return join(home, ".agents", "skills");
}

export function claudeReplicaRoot(home: string): string {
  return join(home, ".claude", "skills");
}

/**
 * Normaliza la fuente del usuario: URL git (con `#ref`), atajo `owner/repo`
 * (→ GitHub) o path local absoluto. Paths relativos se rechazan a propósito:
 * el registro debe poder resolverse desde cualquier cwd futuro.
 */
export function resolveSkillSource(raw: string, ref?: string): ResolvedSource | { error: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { error: "la fuente no puede estar vacía" };
  // file:// cuenta como git (clone por transporte local) — permite registrar
  // repos locales CON historial, a diferencia del path plano.
  if (/^(https?:\/\/|git@|ssh:\/\/|file:\/\/)/.test(trimmed)) {
    const hashIdx = trimmed.indexOf("#");
    const url = hashIdx >= 0 ? trimmed.slice(0, hashIdx) : trimmed;
    const parsedRef = ref ?? (hashIdx >= 0 ? trimmed.slice(hashIdx + 1) : undefined);
    return { kind: "git", url, ...(parsedRef ? { ref: parsedRef } : {}) };
  }
  if (isAbsolute(trimmed)) return { kind: "local", path: trimmed };
  // El atajo GitHub exige segmentos que arranquen alfanuméricos: "./x" o "../x"
  // son paths relativos (rechazados), no owner/repo.
  if (/^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/.test(trimmed)) {
    return { kind: "git", url: `https://github.com/${trimmed}.git`, ...(ref ? { ref } : {}) };
  }
  return {
    error: `fuente inválida: '${raw}'. Usá owner/repo, una URL git o un path local absoluto.`,
  };
}

async function isSkillDir(dir: string): Promise<boolean> {
  try {
    return hasValidFrontmatter(await readFile(join(dir, "SKILL.md"), "utf8"));
  } catch {
    return false;
  }
}

/** `name:` del frontmatter — el nombre real de la skill cuando la fuente ES un
 *  skill-dir (el basename de un clone temporal es aleatorio, jamás sirve). */
function frontmatterName(content: string): string | null {
  const block = content.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
  return block.match(/^name:\s*(\S[^\r\n]*)/m)?.[1]?.trim() ?? null;
}

/** Walk acotado: skills anidadas hasta skills/<categoría>/<skill>; salta
 *  dot-dirs, node_modules y symlinks (Dirent de link no es isDirectory). */
async function walkSkillDirs(dir: string, depth: number): Promise<SkillCandidate[]> {
  if (depth >= MAX_SCAN_DEPTH) return [];
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: SkillCandidate[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (await isSkillDir(full)) {
      out.push({ name: entry.name, path: full });
    } else {
      out.push(...(await walkSkillDirs(full, depth + 1)));
    }
  }
  return out;
}

/** Skill dirs de una fuente: el dir mismo (si ES una skill, nombrado por su
 *  frontmatter) o el árbol; nombres duplicados o inválidos se descartan. */
async function collectCandidates(dir: string): Promise<SkillCandidate[]> {
  if (await isSkillDir(dir)) {
    const content = await readFile(join(dir, "SKILL.md"), "utf8");
    const name = frontmatterName(content) ?? basename(dir);
    return isValidSkillName(name) ? [{ name, path: dir }] : [];
  }
  const found = await walkSkillDirs(dir, 0);
  const byName = new Map<string, SkillCandidate>();
  for (const c of found) {
    if (!isValidSkillName(c.name) || byName.has(c.name)) continue;
    byName.set(c.name, c);
  }
  return [...byName.values()];
}

/** Trae la fuente a un dir legible y lista sus skills (clone temp si es git). */
async function fetchSourceCandidates(
  resolved: ResolvedSource,
  ctx: CliContext,
): Promise<
  { candidates: SkillCandidate[]; cleanup: () => Promise<void> } | { code: string; error: string }
> {
  if (resolved.kind === "local") {
    if (!(await ctx.fs.exists(resolved.path))) {
      return { code: "SOURCE_NOT_FOUND", error: `el path local '${resolved.path}' no existe` };
    }
    return { candidates: await collectCandidates(resolved.path), cleanup: async () => {} };
  }
  const temp = await mkdtemp(join(tmpdir(), "aw-skill-fetch-"));
  const cleanup = async () => {
    await rm(temp, { recursive: true, force: true }).catch(() => {});
  };
  try {
    await gitClone(resolved.url, temp, resolved.ref);
  } catch (err) {
    await cleanup();
    return { code: "GIT_CLONE_FAILED", error: `git clone falló: ${(err as Error).message}` };
  }
  return { candidates: await collectCandidates(temp), cleanup };
}

/** Lectura previa a una mutación: un registro ilegible ABORTA — la primera
 *  escritura tras un read fallido pisaría todas las entradas previas. */
async function readRegistryForWrite(
  ctx: CliContext,
): Promise<{ registry: SkillsRegistry } | { code: string; error: string }> {
  const read = await readSkillsRegistry(ctx);
  if (read.warning) {
    return {
      code: "REGISTRY_UNREADABLE",
      error: `${read.warning} Corregí (o borrá) el archivo antes de operar.`,
    };
  }
  return { registry: read.registry };
}

export async function registerSkill(
  ctx: CliContext,
  input: RegisterInput,
): Promise<CommandResult<RegisterData>> {
  const resolved = resolveSkillSource(input.source, input.ref);
  if ("error" in resolved) return fail("INVALID_SOURCE", resolved.error);

  const fetched = await fetchSourceCandidates(resolved, ctx);
  if ("error" in fetched) return fail(fetched.code, fetched.error);

  try {
    const picked = pickCandidate(fetched.candidates, input);
    if ("error" in picked) return fail(picked.code, picked.error);
    if ("candidates" in picked) {
      return {
        ok: true,
        data: {
          status: "needs-pick",
          candidates: picked.candidates,
          summary: `La fuente contiene ${picked.candidates.length} skills; elegí una para registrar.`,
        },
        exitCode: 0,
      };
    }

    const read = await readRegistryForWrite(ctx);
    if ("error" in read) return fail(read.code, read.error);
    const { registry } = read;
    if (registry.skills[picked.name]) {
      return fail(
        "SKILL_ALREADY_REGISTERED",
        `'${picked.name}' ya está registrada (fuente: ${registry.skills[picked.name]?.source})`,
      );
    }
    // Guard de ownership: un dir canónico existente NO registrado es de otro
    // (bundle `w`, skill de plugin, instalación manual) — nunca lo adoptamos.
    const canonical = join(canonicalSkillsRoot(ctx.env.homeDir()), picked.name);
    if (await ctx.fs.exists(canonical)) {
      return fail(
        "SKILL_NAME_COLLISION",
        `ya existe ${canonical} y no está en el registro de sueltas — elegí otro nombre o resolvé la colisión a mano`,
      );
    }

    const entry: SkillRegistryEntry = {
      source:
        resolved.kind === "git" ? (input.source.split("#")[0] ?? input.source) : resolved.path,
      ...(resolved.kind === "git" && resolved.ref ? { ref: resolved.ref } : {}),
    };
    registry.skills[picked.name] = entry;
    await writeSkillsRegistry(ctx, registry);
    return {
      ok: true,
      data: {
        status: "registered",
        name: picked.name,
        entry,
        summary: `Skill '${picked.name}' registrada desde ${entry.source}.`,
      },
      exitCode: 0,
    };
  } finally {
    await fetched.cleanup();
  }
}

function pickCandidate(
  candidates: SkillCandidate[],
  input: RegisterInput,
): SkillCandidate | { candidates: string[] } | { code: string; error: string } {
  if (candidates.length === 0) {
    return {
      code: "SOURCE_NOT_FOUND",
      error: `no se encontró ninguna skill válida (SKILL.md con name+description) en '${input.source}'`,
    };
  }
  if (input.pick !== undefined) {
    const found = candidates.find((c) => c.name === input.pick);
    return (
      found ?? {
        code: "INVALID_PICK",
        error: `la fuente no contiene la skill '${input.pick}' (disponibles: ${candidates
          .map((c) => c.name)
          .sort()
          .join(", ")})`,
      }
    );
  }
  if (candidates.length === 1 && candidates[0]) return candidates[0];
  return { candidates: candidates.map((c) => c.name).sort() };
}

export async function installSkill(
  ctx: CliContext,
  name: string,
  opts: { refetch: boolean } = { refetch: true },
): Promise<CommandResult<MaterializeData>> {
  const read = await readRegistryForWrite(ctx);
  if ("error" in read) return fail(read.code, read.error);
  const entry = read.registry.skills[name];
  if (!entry) return notRegistered(name);

  const home = ctx.env.homeDir();
  const canonical = join(canonicalSkillsRoot(home), name);

  // Pre-flight ANTES de mutar nada: réplica ajena o colisión de canónica
  // abortan sin tocar la instalación previa ni el dir ajeno.
  const replicaState = await inspectReplica(ctx, name, entry.mode);
  if (replicaState === "foreign") {
    return fail(
      "FOREIGN_REPLICA",
      `ya existe ${join(claudeReplicaRoot(home), name)} y no lo creó este manager — resolvé la colisión a mano`,
    );
  }
  if (opts.refetch && !entry.installedAt && (await ctx.fs.exists(canonical))) {
    return fail(
      "SKILL_NAME_COLLISION",
      `ya existe ${canonical} y este manager no lo materializó — resolvé la colisión a mano`,
    );
  }

  if (opts.refetch) {
    const resolved = resolveSkillSource(entry.source, entry.ref);
    if ("error" in resolved) return fail("INVALID_SOURCE", resolved.error);
    const fetched = await fetchSourceCandidates(resolved, ctx);
    if ("error" in fetched) return fail("FETCH_FAILED", fetched.error);
    try {
      const skillDir = fetched.candidates.find((c) => c.name === name);
      if (!skillDir) {
        return fail(
          "FETCH_FAILED",
          `la fuente '${entry.source}' ya no contiene la skill '${name}'`,
        );
      }
      await materializeCanonical(ctx, skillDir.path, canonical, name);
    } catch (err) {
      return fail("MATERIALIZE_FAILED", (err as Error).message);
    } finally {
      await fetched.cleanup();
    }
  } else if (!entry.installedAt || !(await ctx.fs.exists(canonical))) {
    // Reinstall exige que ESTE manager haya materializado la canónica: sin
    // installedAt, un dir homónimo existente es ajeno y no se replica.
    return fail(
      "SKILL_NOT_INSTALLED",
      `'${name}' no está instalada (no existe ${canonical} materializada por este manager); usá Install/Update`,
    );
  }

  const replica = await replicateToClaude(ctx, name, replicaState);

  // Re-leer antes de escribir: el clone puede tardar y otra invocación pudo
  // tocar el registro en el medio — nunca escribir un snapshot viejo.
  const fresh = await readRegistryForWrite(ctx);
  if ("error" in fresh) return fail(fresh.code, fresh.error);
  const current = fresh.registry.skills[name] ?? entry;
  fresh.registry.skills[name] = {
    ...current,
    mode: replica.mode,
    ...(opts.refetch ? { installedAt: new Date().toISOString() } : {}),
  };
  await writeSkillsRegistry(ctx, fresh.registry);

  return {
    ok: true,
    data: {
      status: opts.refetch ? "installed" : "reinstalled",
      name,
      canonical,
      replica: replica.path,
      mode: replica.mode,
      summary: `Skill '${name}' materializada en ${canonical} (réplica Claude: ${replica.mode}).`,
    },
    exitCode: 0,
  };
}

/** Reinstall: repara canónica→réplica sin tocar la fuente (offline-safe). */
export async function reinstallSkill(
  ctx: CliContext,
  name: string,
): Promise<CommandResult<MaterializeData>> {
  return installSkill(ctx, name, { refetch: false });
}

/** Update: re-fetch del ref registrado; solo fuentes git. Staging+swap: un fallo
 *  de fetch deja la instalación previa intacta. */
export async function updateSkill(
  ctx: CliContext,
  name: string,
): Promise<CommandResult<MaterializeData>> {
  const read = await readRegistryForWrite(ctx);
  if ("error" in read) return fail(read.code, read.error);
  const entry = read.registry.skills[name];
  if (!entry) return notRegistered(name);
  const resolved = resolveSkillSource(entry.source, entry.ref);
  if ("error" in resolved || resolved.kind !== "git") {
    return fail(
      "UPDATE_REQUIRES_GIT",
      `Update re-fetchea git; '${name}' viene de un path local — usá Reinstall (o re-registrá la fuente).`,
    );
  }
  if (!(await ctx.fs.exists(join(canonicalSkillsRoot(ctx.env.homeDir()), name)))) {
    return fail("SKILL_NOT_INSTALLED", `'${name}' no está instalada; usá Install`);
  }
  const result = await installSkill(ctx, name, { refetch: true });
  if (!result.ok || !result.data) return result;
  return {
    ...result,
    data: {
      ...result.data,
      status: "updated",
      summary: `Skill '${name}' actualizada (ref registrado re-fetcheado).`,
    },
  };
}

export async function uninstallSkill(
  ctx: CliContext,
  name: string,
): Promise<CommandResult<UninstallData>> {
  const read = await readRegistryForWrite(ctx);
  if ("error" in read) return fail(read.code, read.error);
  const entry = read.registry.skills[name];
  if (!entry) return notRegistered(name);

  const warning = await teardownSkill(ctx, name, entry);
  read.registry.skills[name] = {
    source: entry.source,
    ...(entry.ref ? { ref: entry.ref } : {}),
  };
  await writeSkillsRegistry(ctx, read.registry);
  return {
    ok: true,
    data: {
      status: "uninstalled",
      name,
      ...(warning ? { warning } : {}),
      summary: `Skill '${name}' desinstalada; sigue registrada (fuente: ${entry.source}).`,
    },
    exitCode: 0,
  };
}

export async function removeSkill(
  ctx: CliContext,
  name: string,
): Promise<CommandResult<UninstallData>> {
  const read = await readRegistryForWrite(ctx);
  if ("error" in read) return fail(read.code, read.error);
  const entry = read.registry.skills[name];
  if (!entry) return notRegistered(name);

  const warning = await teardownSkill(ctx, name, entry);
  delete read.registry.skills[name];
  await writeSkillsRegistry(ctx, read.registry);
  return {
    ok: true,
    data: {
      status: "removed",
      name,
      ...(warning ? { warning } : {}),
      summary: `Skill '${name}' desinstalada y quitada del registro.`,
    },
    exitCode: 0,
  };
}

/** Lista única para la TUI: registradas (instaladas o no) + semilla no registrada.
 *  Orden: installed → registered → recommended; alfabético dentro de cada grupo. */
export async function listSkills(
  ctx: CliContext,
  seed: readonly SeedSkill[],
): Promise<SkillListItem[]> {
  const { registry } = await readSkillsRegistry(ctx);
  const home = ctx.env.homeDir();
  const seedByName = new Map(seed.map((s) => [s.name, s]));

  const items: SkillListItem[] = [];
  for (const [name, entry] of Object.entries(registry.skills)) {
    const canonical = await ctx.fs.exists(join(canonicalSkillsRoot(home), name));
    const replica = (await ctx.fs.lstat(join(claudeReplicaRoot(home), name))) !== null;
    const description = seedByName.get(name)?.description;
    items.push({
      name,
      source: entry.source,
      ...(entry.ref ? { ref: entry.ref } : {}),
      ...(entry.mode ? { mode: entry.mode } : {}),
      ...(entry.installedAt ? { installedAt: entry.installedAt } : {}),
      ...(description ? { description } : {}),
      status: canonical ? "installed" : "registered",
      replicas: { agents: canonical, claude: replica },
    });
  }
  for (const s of seed) {
    if (registry.skills[s.name]) continue;
    items.push({
      name: s.name,
      source: s.source,
      description: s.description,
      status: "recommended",
      replicas: { agents: false, claude: false },
    });
  }

  const rank: Record<SkillStatus, number> = { installed: 0, registered: 1, recommended: 2 };
  return items.sort((a, b) => rank[a.status] - rank[b.status] || a.name.localeCompare(b.name));
}

// --- internos ---

/**
 * Copia src a un staging oculto y lo intercambia con la canónica; el .bak solo
 * se descarta cuando el swap completó — un fallo restaura el estado previo.
 * `renameFn` es inyectable para poder testear la rama de restore.
 */
export async function materializeCanonical(
  ctx: CliContext,
  srcDir: string,
  canonical: string,
  name: string,
  renameFn: typeof rename = rename,
): Promise<void> {
  const root = canonicalSkillsRoot(ctx.env.homeDir());
  await ctx.fs.mkdirp(root);
  const staging = join(root, `.staging-${name}-${process.pid}`);
  const bak = join(root, `.bak-${name}-${process.pid}`);
  await ctx.fs.remove(staging);
  try {
    await copyDir(srcDir, staging);
    const hadPrevious = await ctx.fs.exists(canonical);
    if (hadPrevious) await renameFn(canonical, bak);
    try {
      await renameFn(staging, canonical);
    } catch (err) {
      if (hadPrevious) await renameFn(bak, canonical).catch(() => {});
      throw err;
    }
    if (hadPrevious) await ctx.fs.remove(bak);
  } finally {
    await ctx.fs.remove(staging);
  }
}

type ReplicaState = "absent" | "ours" | "foreign";

/** Ownership de la réplica: nuestra solo si es un symlink que apunta a NUESTRA
 *  canónica, o un dir real con mode:"copy" registrado. Un symlink del usuario
 *  hacia otro lado es ajeno — jamás se re-apunta. */
async function inspectReplica(
  ctx: CliContext,
  name: string,
  registeredMode: SkillReplicaMode | undefined,
): Promise<ReplicaState> {
  const home = ctx.env.homeDir();
  const replica = join(claudeReplicaRoot(home), name);
  const existing = await ctx.fs.lstat(replica);
  if (!existing) return "absent";
  if (existing.isSymlink) {
    try {
      const target = await readlink(replica);
      const canonical = join(canonicalSkillsRoot(home), name);
      return resolve(join(claudeReplicaRoot(home)), target) === resolve(canonical)
        ? "ours"
        : "foreign";
    } catch {
      return "foreign";
    }
  }
  return registeredMode === "copy" ? "ours" : "foreign";
}

/** Materializa la réplica (el pre-flight ya garantizó que no es ajena). */
async function replicateToClaude(
  ctx: CliContext,
  name: string,
  state: Exclude<ReplicaState, "foreign">,
): Promise<{ path: string; mode: SkillReplicaMode }> {
  const home = ctx.env.homeDir();
  const canonical = join(canonicalSkillsRoot(home), name);
  const replica = join(claudeReplicaRoot(home), name);

  if (state === "ours") await ctx.fs.remove(replica);
  await ctx.fs.mkdirp(claudeReplicaRoot(home));
  try {
    await ctx.fs.symlink(canonical, replica);
    return { path: replica, mode: "symlink" };
  } catch {
    // Sin symlinks (Windows sin Developer Mode / EPERM) → copia real.
    await copyDir(canonical, replica);
    return { path: replica, mode: "copy" };
  }
}

/** Desmonta réplica y canónica respetando ownership; devuelve warning si algo
 *  ajeno homónimo se conservó. */
async function teardownSkill(
  ctx: CliContext,
  name: string,
  entry: SkillRegistryEntry,
): Promise<string | undefined> {
  const home = ctx.env.homeDir();
  const warnings: string[] = [];

  const replica = join(claudeReplicaRoot(home), name);
  const replicaState = await inspectReplica(ctx, name, entry.mode);
  if (replicaState === "ours") await ctx.fs.remove(replica);
  else if (replicaState === "foreign") {
    warnings.push(`se conservó ${replica}: existe pero no lo creó este manager`);
  }

  const canonical = join(canonicalSkillsRoot(home), name);
  if (entry.installedAt) {
    await ctx.fs.remove(canonical);
  } else if (await ctx.fs.exists(canonical)) {
    warnings.push(`se conservó ${canonical}: este manager no lo materializó`);
  }
  return warnings.length > 0 ? warnings.join(" · ") : undefined;
}

function notRegistered<T>(name: string): CommandResult<T> {
  return {
    ok: false,
    error: {
      code: "SKILL_NOT_REGISTERED",
      message: `'${name}' no está en el registro de sueltas — este manager no toca dirs que no registró (bundle w, skills de plugins o manuales).`,
    },
    exitCode: 1,
  };
}

function fail<T>(code: string, message: string): CommandResult<T> {
  return { ok: false, error: { code, message }, exitCode: 1 };
}
