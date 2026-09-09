// The change somebody is about to approve, sealed (Spec 043 · AC-09):
// the exact set, the previous and proposed registry, every destination with
// its ownership, and the effect classes the application would exercise.
//
// Preparing is the whole point of this module: it acquires, stages and
// compares WITHOUT publishing into any host root, so cancelling costs nothing
// and approving refers to something that already exists. The digest is what
// makes "is this still the same thing you said yes to?" a property of the data
// instead of a rule somebody has to remember — a moved source, one more
// destination or a byte of payload all produce a different seal.
//
// `applySkillChange` (F3) is the only thing allowed to turn one of these into
// bytes on disk, and it re-reads every precondition under the lock first.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliContext } from "../../cli/types.js";
import type { EffectClass } from "../../domain/capability/effects.js";
import { semanticDigest } from "../semantic-operation/protocol.js";
import { COMMAND_SKILL_PREFIX } from "./install-skill.js";
import {
  type AcquiredSource,
  type SkillCandidate,
  type SourceInventory,
  acquireSource,
  candidateAtPath,
  candidatesNamed,
} from "./skills-discovery.js";
import {
  type SkillOwnership,
  inspectSkillOwnership,
  resolveSkillSource,
} from "./skills-manager.js";
import { type PreparedSkill, type RequiredExpansion, preparePayloads } from "./skills-payload.js";
import {
  type SkillRegistryEntry,
  isValidSkillName,
  readSkillsRegistry,
  skillsRegistryPath,
} from "./skills-registry.js";

/** What the change is, in the vocabulary the person reads. */
export type SkillChangeOperation =
  | "register"
  | "install"
  | "update"
  | "repair"
  | "replace"
  | "uninstall"
  | "remove";

/** One place the application would touch, and what it would do there. */
export interface SkillDestination {
  location: string;
  host: "agents" | "claude" | "gemini" | "registry";
  action: "create" | "replace" | "delete" | "unchanged";
  /** The same HOME every project on this machine reads. */
  shared: boolean;
  ownership: "ours" | "foreign" | "absent";
}

export interface SkillChangeProposal {
  operation: SkillChangeOperation;
  /** Whether the change materializes bytes (and so has an `installedAt` and a
   *  replica mode to stamp) or only touches the registry. */
  installs: boolean;
  /** Names entering or being refreshed, with the payload staged for each. */
  additions: PreparedSkill[];
  /** Managed installations this SAME proposal retires. */
  withdrawals: string[];
  /** Registry entries as they are now (`null` = the name is not registered). */
  previousRegistry: Record<string, SkillRegistryEntry | null>;
  proposedRegistry: Record<string, SkillRegistryEntry | null>;
  destinations: SkillDestination[];
  effects: EffectClass[];
  /** What this proposal does NOT claim. Read before approving. */
  notes: string[];
  digest: string;
}

export interface SkillChangeRequest {
  operation: SkillChangeOperation;
  /** Acquiring operations: where the bytes come from. */
  source?: string;
  ref?: string;
  /** Paths inside the source; `""` is the source root. The exact selection. */
  paths?: string[];
  /** Legacy by-name selection — honoured only when it resolves ONE option. */
  pick?: string;
  /** Managed installations this change retires (a collection → leaves swap). */
  withdraw?: string[];
  /** Non-acquiring operations: the registered name. */
  name?: string;
}

export interface ChangeRejection {
  code: string;
  message: string;
}

export type PrepareOutcome =
  | { status: "prepared"; proposal: SkillChangeProposal; release: () => Promise<void> }
  | {
      status: "needs-choice";
      inventory: SourceInventory;
      candidates: SkillCandidate[];
      release: () => Promise<void>;
    }
  | {
      status: "needs-expansion";
      expansions: RequiredExpansion[];
      release: () => Promise<void>;
    }
  | { status: "rejected"; rejection: ChangeRejection };

const ACQUIRING: readonly SkillChangeOperation[] = ["register", "install", "update", "replace"];

/**
 * Registry entry the proposal would write for a prepared skill.
 *
 * `installedAt` and `mode` are deliberately ABSENT: when the materialization
 * happened and whether the replica ended up a link or a copy are facts of the
 * application, not of the approval — stamping a made-up timestamp here would
 * put a lie inside the seal, and sealing the real one would make an identical
 * retry look like a different change.
 */
function entryFor(skill: PreparedSkill): SkillRegistryEntry {
  return {
    source: skill.provenance.source,
    ...(skill.provenance.requestedRef ? { ref: skill.provenance.requestedRef } : {}),
    ...(skill.path !== "" ? { path: skill.path } : {}),
    ...(skill.name !== skill.provenance.directory ? { skillName: skill.name } : {}),
    ...(skill.provenance.resolvedRef ? { resolvedRef: skill.provenance.resolvedRef } : {}),
    payloadDigest: skill.digest,
  };
}

/** The three managed roots, with the ownership each one reports. */
function destinationsFor(
  ownership: SkillOwnership,
  action: "create" | "replace" | "delete",
): SkillDestination[] {
  const canonical: SkillDestination = {
    location: ownership.canonical.path,
    host: "agents",
    action: ownership.canonical.state === "absent" && action !== "delete" ? "create" : action,
    shared: true,
    ownership: ownership.canonical.state,
  };
  const replicas = ownership.replicas.map<SkillDestination>((replica) => ({
    location: replica.path,
    host: replica.host,
    action: replica.state === "absent" && action !== "delete" ? "create" : action,
    shared: true,
    ownership: replica.state,
  }));
  return [canonical, ...replicas];
}

function effectsOf(destinations: readonly SkillDestination[]): EffectClass[] {
  const effects = new Set<EffectClass>();
  for (const destination of destinations) {
    if (destination.action === "create") effects.add("local_additive");
    if (destination.action === "replace") effects.add("mutate_overwrite");
    if (destination.action === "delete") effects.add("destructive");
  }
  return [...effects];
}

function sealProposal(body: Omit<SkillChangeProposal, "digest">): SkillChangeProposal {
  return {
    ...body,
    digest: semanticDigest({
      operation: body.operation,
      installs: body.installs,
      additions: body.additions
        .map((skill) => ({
          name: skill.name,
          path: skill.path,
          digest: skill.digest,
          manifests: skill.manifests,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      withdrawals: [...body.withdrawals].sort(),
      previous_registry: body.previousRegistry,
      proposed_registry: body.proposedRegistry,
      destinations: [...body.destinations].sort((a, b) => a.location.localeCompare(b.location)),
      effects: [...body.effects].sort(),
    }),
  };
}

type Selection = { candidates: SkillCandidate[] } | { choice: SkillCandidate[] } | ChangeRejection;

/** The exact selection: every path has to BE a skill of this source. */
async function selectionByPaths(
  paths: readonly string[],
  acquired: AcquiredSource,
): Promise<Selection> {
  const byPath = new Map(acquired.inventory.candidates.map((c) => [c.path, c]));
  const chosen: SkillCandidate[] = [];
  for (const path of paths) {
    const walked = byPath.get(path);
    if (walked !== undefined) {
      chosen.push(walked);
      continue;
    }
    // The path is NOT normalized here on purpose: the validator owns both the
    // trimming and the refusal, and stripping a leading slash first turned
    // "this is not a path of the source" into "this does not exist" — a
    // misleading answer about a path that exists, just outside.
    //
    // The walk is not the authority on what the source HAS — it declares its
    // own limits and says when it was cut. An explicit path is validated
    // directly against the source, which is what lets somebody reach a skill
    // deeper than the walk goes, and it refuses by cause: not relative, out of
    // the source, absent, crossing a link, or no manifest there.
    const explicit = await candidateAtPath(acquired.root, path);
    if ("code" in explicit) return explicit;
    chosen.push(explicit);
  }
  return { candidates: chosen };
}

/** By-name selection: honoured only while it resolves ONE option, because two
 *  skills with the same name are two alternatives, not a coin toss. */
function selectionByName(name: string, inventory: SourceInventory): Selection {
  const matches = candidatesNamed(inventory, name);
  if (matches.length === 1 && matches[0]) return { candidates: [matches[0]] };
  if (matches.length === 0) {
    return { code: "INVALID_PICK", message: `el origen no contiene la skill '${name}'` };
  }
  return { choice: matches };
}

/** The selection a request names, or the reason it cannot be resolved yet. */
async function selectionOf(
  request: SkillChangeRequest,
  acquired: AcquiredSource,
): Promise<Selection> {
  const inventory = acquired.inventory;
  if (request.paths !== undefined && request.paths.length > 0) {
    return selectionByPaths(request.paths, acquired);
  }
  if (request.pick !== undefined) return selectionByName(request.pick, inventory);
  if (inventory.candidates.length === 1 && inventory.candidates[0]) {
    return { candidates: [inventory.candidates[0]] };
  }
  if (inventory.candidates.length === 0) {
    return {
      code: "SOURCE_NOT_FOUND",
      message: "no se encontró ninguna skill válida (SKILL.md con name+description)",
    };
  }
  return { choice: [...inventory.candidates] };
}

/** Preconditions the registry imposes on a name entering the manager. */
function registryRefusal(
  name: string,
  previous: SkillRegistryEntry | null,
  ownership: SkillOwnership,
  operation: SkillChangeOperation,
): ChangeRejection | null {
  if (!isValidSkillName(name)) {
    return {
      code: "INVALID_SKILL_NAME",
      message: `'${name}' no es un nombre de skill usable como segmento de ruta`,
    };
  }
  if (name.startsWith(COMMAND_SKILL_PREFIX)) {
    return {
      code: "RESERVED_SKILL_PREFIX",
      message: `'${name}' usa el prefijo reservado '${COMMAND_SKILL_PREFIX}' del bundle`,
    };
  }
  if (operation === "register" && previous !== null) {
    return {
      code: "SKILL_ALREADY_REGISTERED",
      message: `'${name}' ya está registrada (fuente: ${previous.source})`,
    };
  }
  if (ownership.canonical.state === "foreign") {
    return {
      code: "SKILL_NAME_COLLISION",
      message: `ya existe ${ownership.canonical.path} y este manager no lo materializó`,
    };
  }
  const foreign = ownership.replicas.find((replica) => replica.state === "foreign");
  if (foreign) {
    return {
      code: "FOREIGN_REPLICA",
      message: `no se puede tratar ${foreign.path} como propia: existe —o su raíz no es legible— y no la creó este manager`,
    };
  }
  return null;
}

async function withdrawalDestinations(
  ctx: CliContext,
  names: readonly string[],
  registry: Record<string, SkillRegistryEntry>,
): Promise<
  | { destinations: SkillDestination[]; previous: Record<string, SkillRegistryEntry | null> }
  | ChangeRejection
> {
  const destinations: SkillDestination[] = [];
  const previous: Record<string, SkillRegistryEntry | null> = {};
  for (const name of names) {
    const entry = registry[name];
    if (entry === undefined) {
      return {
        code: "SKILL_NOT_REGISTERED",
        message: `'${name}' no está en el registro de sueltas: este manager no toca lo que no registró`,
      };
    }
    previous[name] = entry;
    const ownership = await inspectSkillOwnership(ctx, name, entry);
    // A foreign dir is never deleted: it is reported as preserved.
    for (const destination of destinationsFor(ownership, "delete")) {
      destinations.push(
        destination.ownership === "foreign" ? { ...destination, action: "unchanged" } : destination,
      );
    }
  }
  return { destinations, previous };
}

/**
 * Prepares a change and seals it. Nothing here writes into a host root: the
 * payload is staged in a temp dir the caller releases, and every comparison is
 * a read.
 */
export async function prepareSkillChange(
  ctx: CliContext,
  request: SkillChangeRequest,
): Promise<PrepareOutcome> {
  const read = await readSkillsRegistry(ctx);
  if (read.warning) {
    return {
      status: "rejected",
      rejection: {
        code: "REGISTRY_UNREADABLE",
        message: `${read.warning} Corregí (o borrá) el archivo antes de operar.`,
      },
    };
  }
  const registry = read.registry.skills;
  const home = ctx.env.homeDir();
  const notes = [
    "Preparar no cambia ninguna instalación: el payload queda fuera de las raíces del host.",
    `Las ubicaciones son compartidas por todos los proyectos de este equipo (${home}).`,
    "Aplicar no recarga el host: lo que cada host descubra por su cuenta queda fuera de este alcance.",
  ];

  if (!ACQUIRING.includes(request.operation)) {
    return prepareWithoutSource(ctx, request, registry, notes);
  }

  if (request.source === undefined || request.source.trim().length === 0) {
    return {
      status: "rejected",
      rejection: { code: "INVALID_SOURCE", message: "la fuente no puede estar vacía" },
    };
  }
  // `update` means re-fetching the REGISTERED ref, and a local path has none:
  // the refusal names the operation that does fit instead of quietly doing
  // something else under the same word.
  if (request.operation === "update") {
    const resolved = resolveSkillSource(request.source, request.ref);
    if ("error" in resolved || resolved.kind !== "git") {
      return {
        status: "rejected",
        rejection: {
          code: "UPDATE_REQUIRES_GIT",
          message: `Update re-fetchea git; '${request.source}' es un path local — usá Repair (o cambiá la fuente registrada).`,
        },
      };
    }
  }
  const acquired = await acquireSource(request.source, request.ref);
  if ("code" in acquired) return { status: "rejected", rejection: acquired };

  try {
    return await prepareFromSource(ctx, request, registry, notes, acquired);
  } catch (err) {
    await acquired.release();
    return {
      status: "rejected",
      rejection: { code: "PREPARATION_FAILED", message: (err as Error).message },
    };
  }
}

/** `repair`, `uninstall` and `remove`: no bytes to acquire, effects to declare. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the order of the refusals is the contract a person reads — the name, then the registration, then what the ownership allows — and extracting them would hide that precedence rather than simplify it.
async function prepareWithoutSource(
  ctx: CliContext,
  request: SkillChangeRequest,
  registry: Record<string, SkillRegistryEntry>,
  notes: string[],
): Promise<PrepareOutcome> {
  const name = request.name;
  if (name === undefined) {
    return {
      status: "rejected",
      rejection: { code: "INVALID_INPUT", message: "esta operación necesita el nombre registrado" },
    };
  }
  const entry = registry[name];
  if (entry === undefined) {
    return {
      status: "rejected",
      rejection: {
        code: "SKILL_NOT_REGISTERED",
        message: `'${name}' no está en el registro de sueltas: este manager no toca dirs que no registró (bundle w, skills de plugins o manuales).`,
      },
    };
  }
  const ownership = await inspectSkillOwnership(ctx, name, entry);
  const registryPath = skillsRegistryPath(ctx.env.homeDir());

  if (request.operation === "repair") {
    const foreign = ownership.replicas.find((replica) => replica.state === "foreign");
    if (foreign !== undefined) {
      return {
        status: "rejected",
        rejection: {
          code: "FOREIGN_REPLICA",
          message: `no se puede tratar ${foreign.path} como propia: existe —o su raíz no es legible— y no la creó este manager`,
        },
      };
    }
    if (ownership.canonical.state !== "ours") {
      return {
        status: "rejected",
        rejection: {
          code: "SKILL_NOT_INSTALLED",
          message: `'${name}' no tiene una copia canónica materializada por este manager: reparar sin re-adquirir declararía algo que no comprobó`,
        },
      };
    }
    const destinations = ownership.replicas.map<SkillDestination>((replica) => ({
      location: replica.path,
      host: replica.host,
      action: replica.state === "absent" ? "create" : "replace",
      shared: true,
      ownership: replica.state,
    }));
    const proposal = sealProposal({
      operation: "repair",
      installs: false,
      additions: [],
      withdrawals: [],
      previousRegistry: { [name]: entry },
      proposedRegistry: { [name]: entry },
      destinations: [
        {
          location: ownership.canonical.path,
          host: "agents",
          action: "unchanged",
          shared: true,
          ownership: ownership.canonical.state,
        },
        ...destinations,
      ],
      effects: effectsOf(destinations),
      notes: [
        ...notes,
        "Repara las réplicas desde la copia canónica ya comprobada; no vuelve a la red.",
      ],
    });
    return { status: "prepared", proposal, release: async () => {} };
  }

  const removes = request.operation === "remove";
  const destinations = destinationsFor(ownership, "delete").map<SkillDestination>((destination) =>
    destination.ownership === "foreign" ? { ...destination, action: "unchanged" } : destination,
  );
  destinations.push({
    location: registryPath,
    host: "registry",
    action: "replace",
    shared: true,
    ownership: "ours",
  });
  const proposal = sealProposal({
    operation: request.operation,
    installs: false,
    additions: [],
    withdrawals: [name],
    previousRegistry: { [name]: entry },
    proposedRegistry: {
      [name]: removes
        ? null
        : {
            source: entry.source,
            ...(entry.ref ? { ref: entry.ref } : {}),
            ...(entry.path !== undefined ? { path: entry.path } : {}),
            ...(entry.skillName !== undefined ? { skillName: entry.skillName } : {}),
            ...(entry.resolvedRef !== undefined ? { resolvedRef: entry.resolvedRef } : {}),
            ...(entry.payloadDigest !== undefined ? { payloadDigest: entry.payloadDigest } : {}),
          },
    },
    destinations,
    effects: effectsOf(destinations),
    notes: [
      ...notes,
      removes
        ? "Desinstala y quita el registro. Retirar una recomendación no es esto."
        : "Borra la copia canónica y las réplicas; la registración se conserva.",
      "Las instalaciones ajenas se conservan y se informan; nunca se borran.",
    ],
  });
  return { status: "prepared", proposal, release: async () => {} };
}

/** `register`, `install`, `update` and `replace`: the payload comes first. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the sequence IS the guarantee — selection, then payload, then registry preconditions, then withdrawals, then the seal — and every early exit either releases what the previous step acquired or hands that release to the caller. Splitting it would separate an acquisition from its release.
async function prepareFromSource(
  ctx: CliContext,
  request: SkillChangeRequest,
  registry: Record<string, SkillRegistryEntry>,
  notes: string[],
  acquired: AcquiredSource,
): Promise<PrepareOutcome> {
  const selection = await selectionOf(request, acquired);
  if ("code" in selection) {
    await acquired.release();
    return { status: "rejected", rejection: selection };
  }
  if ("choice" in selection) {
    return {
      status: "needs-choice",
      inventory: acquired.inventory,
      candidates: selection.choice,
      release: acquired.release,
    };
  }

  const staging = await mkdtemp(join(tmpdir(), "aw-skill-stage-"));
  const release = async () => {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    await acquired.release();
  };
  const payload = await preparePayloads(acquired, selection.candidates, staging);
  if (payload.status === "rejected") {
    await release();
    return { status: "rejected", rejection: payload.rejection };
  }
  if (payload.status === "needs-expansion") {
    return { status: "needs-expansion", expansions: payload.expansions, release };
  }

  const installs = request.operation !== "register";
  const previousRegistry: Record<string, SkillRegistryEntry | null> = {};
  const proposedRegistry: Record<string, SkillRegistryEntry | null> = {};
  const destinations: SkillDestination[] = [];
  for (const skill of payload.skills) {
    const previous = registry[skill.name] ?? null;
    const ownership = await inspectSkillOwnership(ctx, skill.name, previous ?? undefined);
    const refusal = registryRefusal(skill.name, previous, ownership, request.operation);
    if (refusal !== null) {
      await release();
      return { status: "rejected", rejection: refusal };
    }
    previousRegistry[skill.name] = previous;
    proposedRegistry[skill.name] = entryFor(skill);
    if (installs) {
      destinations.push(
        ...destinationsFor(ownership, ownership.canonical.state === "ours" ? "replace" : "create"),
      );
    }
  }

  const withdrawals = request.withdraw ?? [];
  if (withdrawals.length > 0) {
    const retired = await withdrawalDestinations(ctx, withdrawals, registry);
    if ("code" in retired) {
      await release();
      return { status: "rejected", rejection: retired };
    }
    destinations.push(...retired.destinations);
    for (const [name, entry] of Object.entries(retired.previous)) {
      previousRegistry[name] = entry;
      proposedRegistry[name] = null;
    }
  }

  destinations.push({
    location: skillsRegistryPath(ctx.env.homeDir()),
    host: "registry",
    action: "replace",
    shared: true,
    ownership: "ours",
  });

  const extra = payload.skills.flatMap((skill) =>
    skill.manifests.length > 1
      ? [
          `'${skill.name}' materializa ${skill.manifests.length} SKILL.md: ${skill.manifests
            .map((manifest) => manifest.name)
            .join(", ")}.`,
        ]
      : [],
  );
  const proposal = sealProposal({
    operation: request.operation,
    installs,
    additions: payload.skills,
    withdrawals: [...withdrawals],
    previousRegistry,
    proposedRegistry,
    destinations,
    effects: installs ? effectsOf(destinations) : ["local_additive"],
    notes: [
      ...notes,
      ...(installs ? [] : ["Registrar no instala: el único efecto es la entrada del registro."]),
      // The warning the old wizard showed on its own step: it belongs in the
      // preview, which is where the decision is actually made.
      "Una skill de terceros corre con los permisos de tu host: revisá su contenido antes de instalarla.",
      ...extra,
      ...(acquired.inventory.truncated
        ? ["El recorrido del origen se cortó por su límite: puede haber más skills."]
        : []),
      "El inventario enumera bytes y digests de lo leído; no certifica el funcionamiento ni la seguridad del paquete.",
    ],
  });
  return { status: "prepared", proposal, release };
}
