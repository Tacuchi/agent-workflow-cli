/**
 * The cross-cutting contract a capability declares, and the only door into this
 * layer.
 *
 * An Agent Skill that is merely installed is a file on disk. What turns it into
 * something SPEC, PLAN, QUICK or a host adapter may invoke is this descriptor:
 * a finite operation catalog, the inputs and outputs each one takes, the context
 * it needs, whether it can ask for more, what it is allowed to DO, what happens
 * when it is `off`, and what a built-in floor guarantees when no improvement is
 * installed. Without it, "a loop composes the design capability" is a sentence
 * in Markdown that nothing can verify.
 *
 * Three boundaries are load-bearing and none of them is stylistic:
 *
 * - **This is not a design format.** It lives outside `domain/design` and
 *   outside `CANONICAL_SCHEMAS`, and it must stay there: the day the capability
 *   contract is catalogued next to `workline.ui-screen/v1`, adding a second
 *   capability means touching the design package's registry.
 * - **The `name` is the whole public identity.** There is no parallel role ID.
 *   `design` the capability and `design` the binding slot are one string, and
 *   `design/capability.ts` proves it at compile time.
 * - **Declaring compatibility is not becoming the capability.** An improvement
 *   keeps its own `name`; its metadata only points at a descriptor it satisfies.
 *   It never earns an alias, a binding or a Workline surface by saying so.
 *
 * The published JSON Schema (`skills/w/schemas/capability-descriptor.schema.json`)
 * is the normative contract; this validator is hand-written (same call as
 * DEC-001: no schema engine, no new dependency) and `capability-descriptor-guard`
 * proves the two never drift.
 */

import { createHash } from "node:crypto";
import { ContractReader, eachRecord, isNonEmptyString, isRecord } from "../contract-reader.js";
import type { AllowedKeys, ContractFailure } from "../contract-reader.js";
import { checkSafeRelativePath } from "../safe-path.js";
import { RETIRED_SKILL_IDENTITIES } from "../skills.js";
import { isEffectClass } from "./effects.js";
import type { EffectDeclaration } from "./effects.js";

export const CAPABILITY_CONTRACT_VERSION = 1;

export const CAPABILITY_DESCRIPTOR_SCHEMA_ID = "workline.capability-descriptor/v1";

/**
 * THE grammar, as pattern fragments.
 *
 * Same discipline as the design package: every regex here and every `pattern` in
 * the published schema is built from these strings, and a guard proves it. A
 * tightened regex that leaves the normative contract describing something looser
 * is a divergence a green test suite will not notice.
 */
export const CAPABILITY_GRAMMAR = {
  /** A capability name is a skill name: lowercase kebab, no leading digit. */
  name: "[a-z][a-z0-9]*(?:-[a-z0-9]+)*",
  /** Operation and input identifiers. */
  identifier: "[a-z][a-z0-9_]*",
  /** A schema id the operation's payload conforms to, e.g. `workline.ui-screen/v1`. */
  schemaId: "[a-z][a-z0-9.-]*/v[1-9][0-9]*",
  digest: "[0-9a-f]{64}",
} as const;

const NAME_RE = new RegExp(`^${CAPABILITY_GRAMMAR.name}$`);
const IDENTIFIER_RE = new RegExp(`^${CAPABILITY_GRAMMAR.identifier}$`);
const SCHEMA_ID_RE = new RegExp(`^${CAPABILITY_GRAMMAR.schemaId}$`);

export const CAPABILITY_EXPOSURES = ["direct", "compose"] as const;
export type CapabilityExposure = (typeof CAPABILITY_EXPOSURES)[number];

/** Whether the operation needs a Workline workspace to mean anything. */
export const WORKSPACE_REQUIREMENTS = ["required", "optional", "standalone"] as const;
export type WorkspaceRequirement = (typeof WORKSPACE_REQUIREMENTS)[number];

/** Whether one attempt is the whole conversation, or it may ask for more. */
export const INTERACTION_MODES = ["single_pass", "needs_input"] as const;
export type InteractionMode = (typeof INTERACTION_MODES)[number];

export const INPUT_KINDS = ["text", "reference", "attachment", "selection"] as const;
export type InputKind = (typeof INPUT_KINDS)[number];

export const INPUT_SENSITIVITIES = ["public", "sensitive"] as const;
export type InputSensitivity = (typeof INPUT_SENSITIVITIES)[number];

export const OUTPUT_KINDS = ["value", "reference", "value_and_reference"] as const;
export type OutputKind = (typeof OUTPUT_KINDS)[number];

/**
 * Completeness is NOT an outcome.
 *
 * An attempt can finish and still hand back something the requested profile does
 * not fully cover; saying so is the only way a gate that demands completeness can
 * refuse it without calling the whole attempt a failure.
 */
export const COMPLETENESS_VALUES = ["complete", "partial"] as const;
export type Completeness = (typeof COMPLETENESS_VALUES)[number];

/** What `off` does to one operation. */
export const OFF_POLICIES = ["blocked", "allowed"] as const;
export type OffPolicy = (typeof OFF_POLICIES)[number];

/** A floor a core gate can count on, or a feature that may simply be absent. */
export const FLOOR_KINDS = ["core", "feature"] as const;
export type FloorKind = (typeof FLOOR_KINDS)[number];

export const IMPROVEMENT_POLICIES = ["host_selected", "none"] as const;
export type ImprovementPolicy = (typeof IMPROVEMENT_POLICIES)[number];

/** Why a run fell back. Every one of them is observable, none is a guess. */
export const DEGRADATION_CAUSES = [
  "opaque_selection",
  "incompatible_improvement",
  "invalid_binding",
  "digest_changed",
] as const;
export type DegradationCause = (typeof DEGRADATION_CAUSES)[number];

export const DEGRADATION_ACTIONS = ["floor", "reject"] as const;
export type DegradationAction = (typeof DEGRADATION_ACTIONS)[number];

export const COMPATIBILITY_STATUSES = ["active", "deprecated"] as const;
export type CompatibilityStatus = (typeof COMPATIBILITY_STATUSES)[number];

export interface CapabilityInput {
  name: string;
  kind: InputKind;
  required: boolean;
  sensitivity: InputSensitivity;
  /** Canonical format id when the input is schema-bearing, else null. */
  schema: string | null;
}

export interface CapabilityOutput {
  kind: OutputKind;
  /** Canonical format id when the output is schema-bearing, else null. */
  schema: string | null;
  /** The completeness values this operation may report. */
  completeness: readonly Completeness[];
}

export interface CapabilityOperation {
  name: string;
  summary: string;
  exposure: readonly CapabilityExposure[];
  workspace: WorkspaceRequirement;
  interaction: InteractionMode;
  inputs: readonly CapabilityInput[];
  output: CapabilityOutput;
  effects: readonly EffectDeclaration[];
  off: OffPolicy;
}

export interface CapabilityFloor {
  /** Whether the capability carries its own implementation with no external skill. */
  builtin: boolean;
  kind: FloorKind;
  improvements: ImprovementPolicy;
}

export interface CapabilityDegradation {
  cause: DegradationCause;
  action: DegradationAction;
}

/**
 * What an improvement claims to improve — its own words, not the host's.
 *
 * "Installed" never implies "compatible", and the host's selection cannot supply
 * the missing half: a host says WHICH skills contribute and in what order, it
 * does not know whether a given skill speaks this capability's contract. So the
 * claim has to live in the improvement's own descriptor, where it can be
 * verified against the capability being resolved before anything contributes.
 *
 * `null` means the descriptor IS the capability, not an improvement to one.
 */
export interface CapabilityImproves {
  capability: string;
  operations: readonly string[];
  contract_version: number;
}

export interface CapabilityCompatibility {
  status: CompatibilityStatus;
  minimum_contract_version: number;
  improves: CapabilityImproves | null;
  /** Names that are NOT aliases: they fail with guidance instead of resolving. */
  retired_names: readonly string[];
  /** Formats that are unsupported as a source: never read, imported or migrated. */
  retired_formats: readonly string[];
}

export interface CapabilityDescriptor {
  contract_version: number;
  name: string;
  purpose: string;
  exposure: readonly CapabilityExposure[];
  default_operation: string | null;
  operations: readonly CapabilityOperation[];
  floor: CapabilityFloor;
  degradations: readonly CapabilityDegradation[];
  compatibility: CapabilityCompatibility;
}

export const ALLOWED_KEYS: AllowedKeys = {
  "": [
    "contract_version",
    "name",
    "purpose",
    "exposure",
    "default_operation",
    "operations",
    "floor",
    "degradations",
    "compatibility",
  ],
  "operations[]": [
    "name",
    "summary",
    "exposure",
    "workspace",
    "interaction",
    "inputs",
    "output",
    "effects",
    "off",
  ],
  "operations[].inputs[]": ["name", "kind", "required", "sensitivity", "schema"],
  "operations[].output": ["kind", "schema", "completeness"],
  "operations[].effects[]": ["class", "idempotent", "authorization", "approval"],
  floor: ["builtin", "kind", "improvements"],
  "degradations[]": ["cause", "action"],
  compatibility: [
    "status",
    "minimum_contract_version",
    "improves",
    "retired_names",
    "retired_formats",
  ],
  "compatibility.improves": ["capability", "operations", "contract_version"],
};

export interface CapabilityDescriptorValidation {
  ok: boolean;
  failures: ContractFailure[];
  touched: ReadonlySet<string>;
  value: CapabilityDescriptor | null;
}

/**
 * Whether an installed skill earns a Workline surface at all.
 *
 * The opt-in is the entire answer to "does installing a linter make it a
 * capability": no descriptor, or a descriptor that exposes nothing, means the
 * skill stays exactly what the host already knows — ambient, discovered by its
 * own description, invoked natively, and invisible to this layer.
 */
export function hasWorklineSurface(descriptor: CapabilityDescriptor | null): boolean {
  return descriptor !== null && descriptor.exposure.length > 0;
}

/** Whether the capability declares `exposure` for the given route. */
export function exposes(descriptor: CapabilityDescriptor, route: CapabilityExposure): boolean {
  return descriptor.exposure.includes(route);
}

export function findOperation(
  descriptor: CapabilityDescriptor,
  operation: string,
): CapabilityOperation | null {
  return descriptor.operations.find((op) => op.name === operation) ?? null;
}

export function validateCapabilityDescriptor(
  raw: unknown,
  artifact = "workline-capability.json",
): CapabilityDescriptorValidation {
  const r = new ContractReader("CAPABILITY", ALLOWED_KEYS);

  if (!isRecord(raw)) {
    r.fail(
      "CAPABILITY_DESCRIPTOR_NOT_OBJECT",
      artifact,
      "el descriptor no es un objeto JSON",
      `reescribí '${artifact}' como un único objeto JSON conforme a ${CAPABILITY_DESCRIPTOR_SCHEMA_ID}`,
    );
    return done(r, null);
  }

  // The version gate runs first and alone: reading fields off a descriptor whose
  // contract we do not know would report a pile of derived nonsense.
  const version = r.read(raw, "contract_version");
  if (version !== CAPABILITY_CONTRACT_VERSION) {
    r.fail(
      "CAPABILITY_CONTRACT_VERSION_UNSUPPORTED",
      artifact,
      `'contract_version' es ${JSON.stringify(version)} y esta CLI implementa ${CAPABILITY_CONTRACT_VERSION}`,
      `declará 'contract_version': ${CAPABILITY_CONTRACT_VERSION} o actualizá la CLI`,
    );
    return done(r, null);
  }

  r.closed(raw, "", artifact);
  readIdentity(r, raw, artifact);
  const operations = readOperations(r, raw, artifact);
  readDefaultOperation(r, raw, artifact, operations);
  readFloor(r, raw, artifact);
  readDegradations(r, raw, artifact);
  readCompatibility(r, raw, artifact);

  return done(r, r.failures.length === 0 ? (raw as unknown as CapabilityDescriptor) : null);
}

function readIdentity(r: ContractReader, raw: Record<string, unknown>, artifact: string): void {
  const name = r.read(raw, "name");
  if (!isNonEmptyString(name) || !NAME_RE.test(name)) {
    r.invalid(
      artifact,
      `'name' debe ser un nombre de skill en minúsculas: ${JSON.stringify(name)}`,
      `escribí 'name' con la forma '${CAPABILITY_GRAMMAR.name}'`,
    );
  } else {
    // A descriptor is an entry surface like any other. Accepting a retired name
    // here would let the identity come back in through the one door that was
    // not watched — and it would come back CARRYING a contract.
    const retired = RETIRED_SKILL_IDENTITIES.get(name.toLowerCase());
    if (retired !== undefined) {
      r.fail(
        "CAPABILITY_NAME_RETIRED",
        artifact,
        `'${name}' está retirado — ${retired}`,
        "publicá el descriptor bajo el nombre vigente de la capacidad",
      );
    }
  }

  const purpose = r.read(raw, "purpose");
  if (!isNonEmptyString(purpose)) {
    r.invalid(
      artifact,
      "'purpose' no puede estar vacío",
      "describí en una frase qué resuelve la capacidad",
    );
  }

  readExposure(r, raw, "exposure", artifact, null);
}

/**
 * Read an exposure list. An operation's list is checked against the capability's
 * so an operation cannot advertise a route the capability itself does not open.
 */
function readExposure(
  r: ContractReader,
  node: Record<string, unknown>,
  path: string,
  artifact: string,
  within: readonly string[] | null,
): CapabilityExposure[] {
  const raw = r.read(node, path);
  if (!Array.isArray(raw) || raw.length === 0) {
    r.invalid(
      artifact,
      `'${path}' debe declarar al menos una ruta`,
      `escribí '${path}': ["direct"], ["compose"] o ambas`,
    );
    return [];
  }
  const out: CapabilityExposure[] = [];
  for (const entry of raw) {
    if (!CAPABILITY_EXPOSURES.includes(entry as CapabilityExposure)) {
      r.invalid(
        artifact,
        `'${path}' no admite ${JSON.stringify(entry)}`,
        `usá solo: ${CAPABILITY_EXPOSURES.join(", ")}`,
      );
      continue;
    }
    if (out.includes(entry as CapabilityExposure)) {
      r.invalid(artifact, `'${path}' repite '${String(entry)}'`, "declará cada ruta una sola vez");
      continue;
    }
    if (within !== null && !within.includes(entry as string)) {
      r.invalid(
        artifact,
        `'${path}' declara '${String(entry)}' y la capacidad no expone esa ruta`,
        "agregá la ruta al 'exposure' de la capacidad o quitala de la operación",
      );
      continue;
    }
    out.push(entry as CapabilityExposure);
  }
  return out;
}

function readOperations(
  r: ContractReader,
  raw: Record<string, unknown>,
  artifact: string,
): string[] {
  const capabilityExposure = Array.isArray(raw.exposure) ? (raw.exposure as string[]) : [];
  const names: string[] = [];

  for (const op of eachRecord(r, raw, "operations", artifact)) {
    const name = r.read(op, "operations[].name");
    if (!isNonEmptyString(name) || !IDENTIFIER_RE.test(name)) {
      r.invalid(
        artifact,
        `'operations[].name' inválido: ${JSON.stringify(name)}`,
        `nombrá la operación con la forma '${CAPABILITY_GRAMMAR.identifier}'`,
      );
    } else if (names.includes(name)) {
      r.invalid(
        artifact,
        `la operación '${name}' está declarada dos veces`,
        "el catálogo de operaciones es finito y sin repeticiones: dejá una sola",
      );
    } else {
      names.push(name);
    }

    const where = isNonEmptyString(name) ? `${artifact} (${name})` : artifact;
    if (!isNonEmptyString(r.read(op, "operations[].summary"))) {
      r.invalid(where, "'summary' no puede estar vacío", "describí la operación en una frase");
    }
    readExposure(r, op, "operations[].exposure", where, capabilityExposure);
    readEnum(r, op, "operations[].workspace", WORKSPACE_REQUIREMENTS, where);
    readEnum(r, op, "operations[].interaction", INTERACTION_MODES, where);
    readInputs(r, op, where);
    readOutput(r, op, where);
    readEffects(r, op, where);
    readEnum(r, op, "operations[].off", OFF_POLICIES, where);
  }

  if (names.length === 0) {
    r.invalid(
      artifact,
      "'operations' no declara ninguna operación válida",
      "una capacidad sin catálogo de operaciones no es invocable: declará al menos una",
    );
  }
  return names;
}

function readInputs(r: ContractReader, op: Record<string, unknown>, artifact: string): void {
  const seen: string[] = [];
  for (const input of eachRecord(r, op, "operations[].inputs", artifact)) {
    const name = r.read(input, "operations[].inputs[].name");
    if (!isNonEmptyString(name) || !IDENTIFIER_RE.test(name)) {
      r.invalid(
        artifact,
        `nombre de input inválido: ${JSON.stringify(name)}`,
        `nombrá el input con la forma '${CAPABILITY_GRAMMAR.identifier}'`,
      );
    } else if (seen.includes(name)) {
      r.invalid(artifact, `el input '${name}' está declarado dos veces`, "dejá una sola entrada");
    } else {
      seen.push(name);
    }

    readEnum(r, input, "operations[].inputs[].kind", INPUT_KINDS, artifact);
    readBoolean(r, input, "operations[].inputs[].required", artifact);
    // Sensitivity is declared per input because it decides authorization, not
    // presentation: reading a sensitive source is never self-authorized.
    readEnum(r, input, "operations[].inputs[].sensitivity", INPUT_SENSITIVITIES, artifact);
    readSchemaId(r, input, "operations[].inputs[].schema", artifact);
  }
}

function readOutput(r: ContractReader, op: Record<string, unknown>, artifact: string): void {
  const output = r.read(op, "operations[].output");
  if (!isRecord(output)) {
    r.invalid(
      artifact,
      "'output' debe ser un objeto",
      "declará 'output' con 'kind', 'schema' y 'completeness'",
    );
    return;
  }
  r.closed(output, "operations[].output", artifact);
  readEnum(r, output, "operations[].output.kind", OUTPUT_KINDS, artifact);
  readSchemaId(r, output, "operations[].output.schema", artifact);

  const completeness = r.read(output, "operations[].output.completeness");
  if (!Array.isArray(completeness) || completeness.length === 0) {
    r.invalid(
      artifact,
      "'output.completeness' debe declarar al menos un valor",
      `usá alguno de: ${COMPLETENESS_VALUES.join(", ")}`,
    );
    return;
  }
  const seen: string[] = [];
  for (const value of completeness) {
    if (!COMPLETENESS_VALUES.includes(value as Completeness)) {
      r.invalid(
        artifact,
        `'output.completeness' no admite ${JSON.stringify(value)}`,
        `usá solo: ${COMPLETENESS_VALUES.join(", ")}`,
      );
      continue;
    }
    if (seen.includes(value as string)) {
      r.invalid(artifact, `'output.completeness' repite '${String(value)}'`, "dejá un solo valor");
      continue;
    }
    seen.push(value as string);
  }
}

function readEffects(r: ContractReader, op: Record<string, unknown>, artifact: string): void {
  const seen: string[] = [];
  let count = 0;
  for (const effect of eachRecord(r, op, "operations[].effects", artifact)) {
    count += 1;
    const cls = r.read(effect, "operations[].effects[].class");
    if (!isEffectClass(cls)) {
      r.invalid(
        artifact,
        `clase de efecto desconocida: ${JSON.stringify(cls)}`,
        "declará una clase de la taxonomía de efectos",
      );
    } else if (seen.includes(cls)) {
      r.invalid(
        artifact,
        `la clase de efecto '${cls}' está declarada dos veces`,
        "declará cada clase una sola vez por operación",
      );
    } else {
      seen.push(cls);
    }
    readBoolean(r, effect, "operations[].effects[].idempotent", artifact);
    readEnum(
      r,
      effect,
      "operations[].effects[].authorization",
      ["invocation", "preflight"] as const,
      artifact,
    );
    readEnum(r, effect, "operations[].effects[].approval", ["none", "visible"] as const, artifact);
  }
  // An operation that declares nothing authorizes nothing — including reading.
  // `read_only` is a declaration, not the absence of one.
  if (count === 0) {
    r.invalid(
      artifact,
      "'effects' no declara ninguna clase",
      "declará al menos 'read_only': un efecto no declarado no se ejerce",
    );
  }
}

function readDefaultOperation(
  r: ContractReader,
  raw: Record<string, unknown>,
  artifact: string,
  operations: string[],
): void {
  const value = r.read(raw, "default_operation");
  if (value === null) return;
  if (value === undefined) {
    r.invalid(
      artifact,
      "falta 'default_operation'",
      "declará el nombre de la operación por defecto, o null si no hay",
    );
    return;
  }
  if (!isNonEmptyString(value) || !operations.includes(value)) {
    r.invalid(
      artifact,
      `'default_operation' nombra ${JSON.stringify(value)}, que no está en el catálogo`,
      `usá una de: ${operations.join(", ")} — o null`,
    );
  }
}

function readFloor(r: ContractReader, raw: Record<string, unknown>, artifact: string): void {
  const floor = r.read(raw, "floor");
  if (!isRecord(floor)) {
    r.invalid(
      artifact,
      "'floor' debe ser un objeto",
      "declará 'floor' con 'builtin', 'kind' e 'improvements'",
    );
    return;
  }
  r.closed(floor, "floor", artifact);
  const builtin = readBoolean(r, floor, "floor.builtin", artifact);
  const kind = readEnum(r, floor, "floor.kind", FLOOR_KINDS, artifact);
  readEnum(r, floor, "floor.improvements", IMPROVEMENT_POLICIES, artifact);

  // The single rule that keeps a core gate from depending on an external
  // install: something a flow cannot proceed without has to run with nothing
  // installed. A feature may legitimately be absent — and blocks only itself.
  if (kind === "core" && builtin === false) {
    r.invalid(
      artifact,
      "una capacidad 'core' sin floor incorporado bloquearía un gate al faltar una skill externa",
      "declará 'floor.builtin': true, o bajá 'floor.kind' a 'feature'",
    );
  }
}

function readDegradations(r: ContractReader, raw: Record<string, unknown>, artifact: string): void {
  for (const entry of eachRecord(r, raw, "degradations", artifact)) {
    readEnum(r, entry, "degradations[].cause", DEGRADATION_CAUSES, artifact);
    readEnum(r, entry, "degradations[].action", DEGRADATION_ACTIONS, artifact);
  }
}

function readCompatibility(
  r: ContractReader,
  raw: Record<string, unknown>,
  artifact: string,
): void {
  const compat = r.read(raw, "compatibility");
  if (!isRecord(compat)) {
    r.invalid(
      artifact,
      "'compatibility' debe ser un objeto",
      "declará 'compatibility' con estado, versión mínima y nombres/formatos retirados",
    );
    return;
  }
  r.closed(compat, "compatibility", artifact);
  readEnum(r, compat, "compatibility.status", COMPATIBILITY_STATUSES, artifact);

  const minimum = r.read(compat, "compatibility.minimum_contract_version");
  if (typeof minimum !== "number" || !Number.isInteger(minimum) || minimum < 1) {
    r.invalid(
      artifact,
      `'minimum_contract_version' debe ser un entero ≥ 1: ${JSON.stringify(minimum)}`,
      "declará la versión de contrato más antigua que este descriptor acepta",
    );
  } else if (minimum > CAPABILITY_CONTRACT_VERSION) {
    r.invalid(
      artifact,
      `'minimum_contract_version' (${minimum}) es mayor que la versión declarada (${CAPABILITY_CONTRACT_VERSION})`,
      "bajá el mínimo o publicá el descriptor contra una versión de contrato mayor",
    );
  }

  const name = isNonEmptyString(raw.name) ? raw.name : null;
  readImproves(r, compat, artifact, name);
  readNameList(r, compat, "compatibility.retired_names", artifact, name);
  readStringList(r, compat, "compatibility.retired_formats", artifact);
}

/**
 * A descriptor either IS a capability (`improves: null`) or improves one. The
 * claim is read here so the resolution can verify it against the capability
 * being resolved instead of trusting the host's word that the two match.
 */
function readImproves(
  r: ContractReader,
  compat: Record<string, unknown>,
  artifact: string,
  ownName: string | null,
): void {
  const improves = r.read(compat, "compatibility.improves");
  if (improves === null) return;
  if (!isRecord(improves)) {
    r.invalid(
      artifact,
      "'compatibility.improves' debe ser un objeto o null",
      "declará qué capacidad, operaciones y versión de contrato mejora, o null si el descriptor es la capacidad",
    );
    return;
  }
  r.closed(improves, "compatibility.improves", artifact);
  readImprovedCapability(r, improves, artifact, ownName);
  readImprovedOperations(r, improves, artifact);

  const version = r.read(improves, "compatibility.improves.contract_version");
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    r.invalid(
      artifact,
      `'improves.contract_version' debe ser un entero ≥ 1: ${JSON.stringify(version)}`,
      "declará la versión de contrato de la capacidad que mejora",
    );
  }
}

function readImprovedCapability(
  r: ContractReader,
  improves: Record<string, unknown>,
  artifact: string,
  ownName: string | null,
): void {
  const capability = r.read(improves, "compatibility.improves.capability");
  if (!isNonEmptyString(capability) || !NAME_RE.test(capability)) {
    r.invalid(
      artifact,
      `'improves.capability' inválido: ${JSON.stringify(capability)}`,
      `nombrá la capacidad con la forma '${CAPABILITY_GRAMMAR.name}'`,
    );
    return;
  }
  // Self-improvement would let a descriptor grant itself the compatibility it is
  // supposed to be claiming about something else.
  if (capability === ownName) {
    r.invalid(
      artifact,
      `'${capability}' declara mejorarse a sí misma`,
      "una mejora nombra OTRA capacidad; si el descriptor es la capacidad, poné 'improves': null",
    );
  }
}

function readImprovedOperations(
  r: ContractReader,
  improves: Record<string, unknown>,
  artifact: string,
): void {
  const operations = r.read(improves, "compatibility.improves.operations");
  if (!Array.isArray(operations) || operations.length === 0) {
    r.invalid(
      artifact,
      "'improves.operations' debe enumerar al menos una operación",
      "declará qué operaciones mejora: una mejora que no dice cuáles no se puede verificar",
    );
    return;
  }
  for (const entry of operations) {
    if (isNonEmptyString(entry) && IDENTIFIER_RE.test(entry)) continue;
    r.invalid(
      artifact,
      `'improves.operations' no admite ${JSON.stringify(entry)}`,
      `nombrá cada operación con la forma '${CAPABILITY_GRAMMAR.identifier}'`,
    );
  }
}

/** Retired names fail with guidance; listing the live name among them is a loop. */
function readNameList(
  r: ContractReader,
  node: Record<string, unknown>,
  path: string,
  artifact: string,
  liveName: string | null,
): void {
  const list = r.read(node, path);
  if (!Array.isArray(list)) {
    r.invalid(artifact, `'${path}' debe ser un array`, `escribí '${path}': []`);
    return;
  }
  for (const entry of list) {
    if (!isNonEmptyString(entry) || !NAME_RE.test(entry)) {
      r.invalid(
        artifact,
        `'${path}' no admite ${JSON.stringify(entry)}`,
        `usá nombres con la forma '${CAPABILITY_GRAMMAR.name}'`,
      );
      continue;
    }
    if (entry === liveName) {
      r.invalid(
        artifact,
        `'${path}' retira '${entry}', que es el nombre vigente de la capacidad`,
        "quitá el nombre vigente de la lista de retirados",
      );
    }
  }
}

function readStringList(
  r: ContractReader,
  node: Record<string, unknown>,
  path: string,
  artifact: string,
): void {
  const list = r.read(node, path);
  if (!Array.isArray(list)) {
    r.invalid(artifact, `'${path}' debe ser un array`, `escribí '${path}': []`);
    return;
  }
  for (const entry of list) {
    if (!isNonEmptyString(entry)) {
      r.invalid(artifact, `'${path}' no admite ${JSON.stringify(entry)}`, "usá strings no vacíos");
    }
  }
}

function readEnum<T extends string>(
  r: ContractReader,
  node: Record<string, unknown>,
  path: string,
  values: readonly T[],
  artifact: string,
): T | null {
  const value = r.read(node, path);
  if (typeof value === "string" && (values as readonly string[]).includes(value)) {
    return value as T;
  }
  const field = path.split(".").pop() as string;
  r.invalid(
    artifact,
    `'${field}' no admite ${JSON.stringify(value)}`,
    `usá alguno de: ${values.join(", ")}`,
  );
  return null;
}

function readBoolean(
  r: ContractReader,
  node: Record<string, unknown>,
  path: string,
  artifact: string,
): boolean | null {
  const value = r.read(node, path);
  if (typeof value === "boolean") return value;
  const field = path.split(".").pop() as string;
  r.invalid(artifact, `'${field}' debe ser booleano`, `escribí '${field}': true o false`);
  return null;
}

function readSchemaId(
  r: ContractReader,
  node: Record<string, unknown>,
  path: string,
  artifact: string,
): void {
  const value = r.read(node, path);
  if (value === null) return;
  if (!isNonEmptyString(value) || !SCHEMA_ID_RE.test(value)) {
    const field = path.split(".").pop() as string;
    r.invalid(
      artifact,
      `'${field}' debe ser un id de schema o null: ${JSON.stringify(value)}`,
      `usá la forma '${CAPABILITY_GRAMMAR.schemaId}', p. ej. 'workline.design-manifest/v1'`,
    );
  }
}

function done(
  r: ContractReader,
  value: CapabilityDescriptor | null,
): CapabilityDescriptorValidation {
  return { ok: r.failures.length === 0, failures: r.failures, touched: r.touched, value };
}

/**
 * How an improvement points at the descriptor it satisfies — and nothing more.
 *
 * The Agent Skills standard gives a skill directory `SKILL.md` plus whatever
 * files it wants, and `metadata` as a flat string→string map. That is enough:
 * one namespaced scalar key holds a RELATIVE path to a JSON file inside the
 * skill's own directory, sealed with the digest of its bytes.
 *
 * Everything about that shape is defensive. Relative and confined, because the
 * value crosses a trust boundary — it is authored by whoever wrote the skill.
 * Sealed, because a descriptor that changes under a pinned selection is exactly
 * the staleness the receipt has to be able to name. Scalar, because nested YAML
 * would be a second frontmatter dialect for one field. And a locator LOCATES: it
 * fixes no binding, creates no alias and grants no identity — resolving it only
 * tells you which contract the skill claims to satisfy, a claim the loader then
 * has to verify.
 */
export const CAPABILITY_DESCRIPTOR_METADATA_KEY = "workline-capability-descriptor";

const LOCATOR_RE = new RegExp(`^(.+)#sha256=(${CAPABILITY_GRAMMAR.digest})$`);

export interface DescriptorLocator {
  /** Skill-directory-relative path to the descriptor JSON. */
  path: string;
  /** Lowercase hex SHA-256 the file's bytes must produce. */
  digest: string;
}

export type LocatorParse =
  | { ok: true; locator: DescriptorLocator }
  | { ok: false; code: string; message: string; action: string };

export function parseDescriptorLocator(raw: unknown): LocatorParse {
  const reject = (message: string, action: string): LocatorParse => ({
    ok: false,
    code: "CAPABILITY_LOCATOR_INVALID",
    message,
    action,
  });

  if (!isNonEmptyString(raw)) {
    return reject(
      `'${CAPABILITY_DESCRIPTOR_METADATA_KEY}' debe ser un string no vacío`,
      `escribí '${CAPABILITY_DESCRIPTOR_METADATA_KEY}: "<ruta-relativa>.json#sha256=<64-hex>"'`,
    );
  }

  const match = raw.trim().match(LOCATOR_RE);
  if (match?.[1] === undefined || match[2] === undefined) {
    return reject(
      `el locator '${raw}' no tiene la forma '<ruta-relativa>.json#sha256=<64-hex>'`,
      "agregá el sello '#sha256=' con el digest hex en minúsculas de 64 caracteres",
    );
  }

  const safe = checkSafeRelativePath(match[1]);
  if (!safe.ok) {
    return reject(
      `la ruta del locator '${match[1]}' ${safe.why}`,
      "usá una ruta relativa dentro del directorio de la skill, sin '..' ni raíz absoluta",
    );
  }
  if (!safe.path.endsWith(".json")) {
    return reject(
      `la ruta del locator '${safe.path}' no apunta a un archivo .json`,
      "el descriptor se publica como JSON: apuntá al archivo .json de la skill",
    );
  }

  return { ok: true, locator: { path: safe.path, digest: match[2] } };
}

export type DescriptorPayloadCheck =
  | { ok: true; descriptor: CapabilityDescriptor }
  | { ok: false; code: string; message: string; action: string };

/**
 * Verify the bytes a locator points at, in the order that matters.
 *
 * Seal first, then shape. Checking the digest before parsing means a descriptor
 * that changed under a pinned selection is rejected as STALE rather than
 * reported as a pile of field errors from a document nobody promised — and a
 * tampered file never reaches the parser at all. The contract version is then
 * settled inside the validator before any other field is read, so compatibility
 * is never inferred from a shape this CLI does not understand.
 *
 * Filesystem access deliberately stays out: whoever read the bytes also owns
 * proving they came from inside the skill's own directory.
 */
export function verifyDescriptorPayload(
  locator: DescriptorLocator,
  bytes: string,
): DescriptorPayloadCheck {
  const actual = createHash("sha256").update(bytes, "utf8").digest("hex");
  if (actual !== locator.digest) {
    return {
      ok: false,
      code: "CAPABILITY_DESCRIPTOR_DIGEST_MISMATCH",
      message: `'${locator.path}' sella ${locator.digest} y sus bytes dan ${actual}`,
      action: "actualizá el digest del locator, o restaurá el descriptor que ese sello describe",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes);
  } catch {
    return {
      ok: false,
      code: "CAPABILITY_DESCRIPTOR_NOT_JSON",
      message: `'${locator.path}' no es JSON válido`,
      action: "publicá el descriptor como un único objeto JSON",
    };
  }

  const validation = validateCapabilityDescriptor(parsed, locator.path);
  if (!validation.ok || validation.value === null) {
    const first = validation.failures[0];
    return {
      ok: false,
      code: first?.code ?? "CAPABILITY_DESCRIPTOR_INVALID",
      message: first?.message ?? `'${locator.path}' no cumple el contrato`,
      action: first?.action ?? "corregí el descriptor contra el schema publicado",
    };
  }
  return { ok: true, descriptor: validation.value };
}
