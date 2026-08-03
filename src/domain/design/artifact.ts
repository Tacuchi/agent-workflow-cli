import {
  type DesignDocKind,
  PLACEHOLDER,
  type ParsedBody,
  bodyCriteria,
  bodyDigests,
  bodyReferences,
  checkHeadings,
  conditionalKeys,
  parseBody,
} from "./artifact-body.js";
import { CANONICAL_SCHEMAS } from "./capability.js";
import {
  ARTIFACT_PREFIX,
  type ArtifactRef,
  anchorIsTheProblem,
  isDigest,
  isPackageId,
  isRevision,
  parseArtifactId,
  parseArtifactRef,
} from "./identity.js";
import {
  type AllowedKeys,
  type DesignFailure,
  Reader,
  eachRecord,
  isNonEmptyString,
  isRecord,
} from "./validation.js";
import { parseYamlSubset } from "./yaml-subset.js";

/**
 * Flow and Screen Specifications v1 — the two documents that carry the design
 * semantics of a package.
 *
 * The contract's whole point: **identity, graph, states, dependencies and
 * traceability resolve from the frontmatter alone**. Nothing normative may
 * require reading a sentence. The body still has a contract (fixed headings,
 * real text), but it is checked AGAINST the frontmatter, never trusted instead
 * of it — and where the body cites an artifact, it must cite one the
 * frontmatter already declares.
 */

export const FLOW_SCHEMA_ID = CANONICAL_SCHEMAS.flow;
export const SCREEN_SCHEMA_ID = CANONICAL_SCHEMAS.screen;

export const SCHEMA_ID: Record<DesignDocKind, string> = {
  flow: FLOW_SCHEMA_ID,
  screen: SCREEN_SCHEMA_ID,
};

export type DesignMaturity = "outline" | "handoff";

export interface TraceEntry {
  criterion: string;
  /** Workspace path of the spec/plan the criterion lives in, when known. */
  source: string | null;
}

export interface UnknownEntry {
  question: string;
  /** Whether resolving it could change behavior or acceptance. */
  blocking: boolean;
}

export interface EdgeEntry {
  from: string;
  trigger: string;
  action: string | null;
  condition: string | null;
  to: string;
}

export interface StateEntry {
  anchor: string;
  purpose: string;
}

export interface ScreenDependencies {
  rules: string[];
  tokens: string[];
  assets: string[];
}

interface CommonFields {
  schema: string;
  id: string;
  revision: number;
  maturity: DesignMaturity;
  supersedes: string | null;
  purpose: string;
  platform: string;
  trace: TraceEntry[];
  unknowns: UnknownEntry[];
  not_applicable: Record<string, string>;
  /** Foreign design systems this revision pins. Empty is the normal case. */
  external: ExternalDesignSystem[];
}

/** Provider, revision and digest of a design system that lives somewhere else. */
export interface ExternalDesignSystem {
  provider: string;
  revision: number;
  digest: string;
}

export interface FlowArtifact extends CommonFields {
  kind: "flow";
  actors: string[];
  entry: string;
  nodes: string[];
  edges: EdgeEntry[];
  dependencies: string[];
}

export interface ScreenArtifact extends CommonFields {
  kind: "screen";
  title: string;
  default_state: string;
  states: StateEntry[];
  flow_refs: string[];
  dependencies: ScreenDependencies;
}

export type DesignArtifact = FlowArtifact | ScreenArtifact;

export interface DesignArtifactValidation {
  ok: boolean;
  value: DesignArtifact | null;
  failures: DesignFailure[];
  /** Property paths read — the drift guard's evidence. See `validation.ts`. */
  touched: ReadonlySet<string>;
}

const COMMON_KEYS = [
  "schema",
  "id",
  "revision",
  "maturity",
  "supersedes",
  "purpose",
  "platform",
  "trace",
  "unknowns",
  "not_applicable",
  "external",
];

export const FLOW_ALLOWED_KEYS: AllowedKeys = {
  "": [...COMMON_KEYS, "actors", "entry", "nodes", "edges", "dependencies"],
  "edges[]": ["from", "trigger", "action", "condition", "to"],
  "trace[]": ["criterion", "source"],
  "unknowns[]": ["question", "blocking"],
  "external[]": ["provider", "revision", "digest"],
};

export const SCREEN_ALLOWED_KEYS: AllowedKeys = {
  "": [...COMMON_KEYS, "title", "default_state", "states", "flow_refs", "dependencies"],
  "states[]": ["anchor", "purpose"],
  "trace[]": ["criterion", "source"],
  "unknowns[]": ["question", "blocking"],
  "external[]": ["provider", "revision", "digest"],
  dependencies: ["rules", "tokens", "assets"],
};

export const ALLOWED_KEYS: Record<DesignDocKind, AllowedKeys> = {
  flow: FLOW_ALLOWED_KEYS,
  screen: SCREEN_ALLOWED_KEYS,
};

const ANCHOR_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * A free-text frontmatter field, checked against the SAME placeholder list the
 * body uses. AC-SEM-08 forbids `N/A` in identity, purpose, platform, base state,
 * references and traceability — and the only sanctioned way to say "does not
 * apply" is `not_applicable.<section>`, which covers sections, never fields.
 */
function checkText(
  r: Reader,
  artifact: string,
  field: string,
  value: unknown,
  action: string,
): value is string {
  if (!isNonEmptyString(value)) {
    r.invalid(artifact, `'${field}' es obligatorio y no admite vacío`, action);
    return false;
  }
  if (PLACEHOLDER.test(value.trim())) {
    r.fail(
      "DESIGN_FIELD_PLACEHOLDER",
      artifact,
      `'${field}' dice solo '${value.trim()}'`,
      "un campo del frontmatter no se declara no aplicable: escribí su valor",
    );
    return false;
  }
  return true;
}
const DELIMITER = "---";

export interface SplitDocument {
  frontmatter: string;
  body: string;
  /** 1-based line the body starts at, so a diagnostic points at the real file. */
  bodyLine: number;
}

/** Split `---`-fenced frontmatter from the Markdown body. */
export function splitDesignDocument(text: string): SplitDocument | null {
  const lines = text.split(/\r?\n/);
  if ((lines[0] ?? "").trim() !== DELIMITER) return null;
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] ?? "").trim() !== DELIMITER) continue;
    return {
      frontmatter: lines.slice(1, i).join("\n"),
      body: lines.slice(i + 1).join("\n"),
      bodyLine: i + 2,
    };
  }
  return null;
}

export function validateDesignArtifact(
  text: string,
  kind: DesignDocKind,
  artifact: string,
): DesignArtifactValidation {
  const r = new Reader(ALLOWED_KEYS[kind]);
  const split = splitDesignDocument(text);
  if (split === null) {
    r.fail(
      "DESIGN_FRONTMATTER_MISSING",
      artifact,
      "el documento no abre y cierra un frontmatter '---'",
      `empezá el archivo con '---', el frontmatter ${SCHEMA_ID[kind]} y otro '---'`,
    );
    return { ok: false, value: null, failures: r.failures, touched: r.touched };
  }

  const parsed = parseYamlSubset(split.frontmatter);
  if (!parsed.ok) {
    r.fail(
      "DESIGN_FRONTMATTER_UNREADABLE",
      artifact,
      `el frontmatter no es legible (línea ${parsed.line + 1}): ${parsed.why}`,
      "el contrato admite un subconjunto de YAML: mappings, secuencias, flow style y escalares",
    );
    return { ok: false, value: null, failures: r.failures, touched: r.touched };
  }

  const front = parsed.value as Record<string, unknown>;

  // The version gate runs first and alone: reading fields off a frontmatter
  // whose shape we do not know would report a pile of derived nonsense.
  const schema = r.read(front, "schema");
  if (schema !== SCHEMA_ID[kind]) {
    r.fail(
      "DESIGN_SCHEMA_UNKNOWN",
      artifact,
      `versión de formato no soportada: ${JSON.stringify(schema)}`,
      `este Workline entiende ${SCHEMA_ID[kind]}`,
    );
    return { ok: false, value: null, failures: r.failures, touched: r.touched };
  }

  r.closed(front, "", artifact);
  const common = readCommon(r, front, kind, artifact);
  const specific = kind === "flow" ? readFlow(r, front, artifact) : readScreen(r, front, artifact);

  const body = parseBody(split.body, split.bodyLine);
  checkHeadings(r, body, kind, artifact);
  checkNotApplicable(r, common.not_applicable, kind, artifact);
  checkBodyAgainstFrontmatter(r, body, kind, artifact, common, specific);

  if (r.failures.length > 0) {
    return { ok: false, value: null, failures: r.failures, touched: r.touched };
  }
  return {
    ok: true,
    value: { kind, ...common, ...specific } as DesignArtifact,
    failures: [],
    touched: r.touched,
  };
}

interface CommonRead {
  id: string;
  revision: number;
  maturity: DesignMaturity;
  supersedes: string | null;
  purpose: string;
  platform: string;
  trace: TraceEntry[];
  unknowns: UnknownEntry[];
  not_applicable: Record<string, string>;
  external: ExternalDesignSystem[];
  schema: string;
}

function readCommon(
  r: Reader,
  front: Record<string, unknown>,
  kind: DesignDocKind,
  artifact: string,
): CommonRead {
  const rawId = r.read(front, "id");
  const parsedId = parseArtifactId(rawId);
  const expectedPrefix = ARTIFACT_PREFIX[kind];
  if (parsedId === null || !parsedId.artifact.startsWith(`${expectedPrefix}-`)) {
    r.invalid(
      artifact,
      `'id' debe ser DES-NNN/${expectedPrefix}-NNN y llegó ${JSON.stringify(rawId)}`,
      `escribí la identidad completa, por ejemplo DES-001/${expectedPrefix}-001`,
    );
  }

  const revision = r.read(front, "revision");
  if (!isRevision(revision)) {
    r.invalid(
      artifact,
      "'revision' debe ser un entero >= 1",
      "las revisiones son lógicas y empiezan en 1",
    );
  }

  const maturity = r.read(front, "maturity");
  if (maturity !== "outline" && maturity !== "handoff") {
    r.invalid(
      artifact,
      `'maturity' debe ser 'outline' o 'handoff' y llegó ${JSON.stringify(maturity)}`,
      "declará la madurez de esta revisión",
    );
  }

  const supersedes = r.read(front, "supersedes");
  checkSupersedes(r, supersedes, artifact, rawId, revision);

  const purpose = r.read(front, "purpose");
  checkText(r, artifact, "purpose", purpose, "escribí para qué existe este artefacto");
  const platform = r.read(front, "platform");
  checkText(r, artifact, "platform", platform, "declará la plataforma, por ejemplo web");

  return {
    schema: SCHEMA_ID[kind],
    id: typeof rawId === "string" ? rawId : "",
    revision: isRevision(revision) ? revision : 0,
    maturity: maturity === "handoff" ? "handoff" : "outline",
    supersedes: typeof supersedes === "string" ? supersedes : null,
    purpose: typeof purpose === "string" ? purpose : "",
    platform: typeof platform === "string" ? platform : "",
    trace: readTrace(r, front, artifact),
    unknowns: readUnknowns(r, front, artifact),
    not_applicable: readNotApplicable(r, front, artifact),
    external: readExternal(r, front, artifact),
  };
}

/**
 * The design systems this revision borrows from (AC-PKG-09).
 *
 * Pinning is the whole point: a provider without a revision and a digest is a
 * promise that can change underneath the artifact, which is the situation
 * `outline` exists to describe.
 */
function readExternal(
  r: Reader,
  front: Record<string, unknown>,
  artifact: string,
): ExternalDesignSystem[] {
  const raw = r.read(front, "external");
  if (raw === undefined) {
    r.invalid(artifact, "'external' es obligatorio", "usá [] si no dependés de otro design system");
    return [];
  }
  const out: ExternalDesignSystem[] = [];
  for (const entry of eachRecord(r, front, "external", artifact)) {
    const provider = r.read(entry, "external[].provider");
    const revision = r.read(entry, "external[].revision");
    const digest = r.read(entry, "external[].digest");
    if (!isPackageId(provider) || !isRevision(revision) || !isDigest(digest)) {
      r.invalid(
        artifact,
        "cada 'external' fija provider DES-NNN, revision entera y digest sha256",
        "sin proveedor, revisión y digest la dependencia no está fijada",
      );
      continue;
    }
    out.push({ provider: provider as string, revision, digest: digest as string });
  }
  return out;
}

/**
 * A revision may only supersede an EARLIER revision of ITSELF. Pointing at
 * another artifact would make `supersedes` a second, weaker way of saying
 * "replaces", and currentness is derived from it.
 */
function checkSupersedes(
  r: Reader,
  supersedes: unknown,
  artifact: string,
  rawId: unknown,
  revision: unknown,
): void {
  if (supersedes === undefined) {
    r.invalid(
      artifact,
      "falta 'supersedes': el contrato la declara obligatoria",
      "poné 'supersedes: null' si esta revisión no reemplaza a ninguna",
    );
    return;
  }
  if (supersedes === null) return;
  if (anchorIsTheProblem(supersedes)) {
    r.invalid(
      artifact,
      `'supersedes' lleva un anchor de estado y supersede una REVISIÓN entera`,
      "quitá el anchor: se supersede la revisión, no uno de sus estados",
    );
    return;
  }
  const ref = parseArtifactRef(supersedes);
  if (ref === null) {
    r.invalid(
      artifact,
      `'supersedes' debe ser null o DES-NNN/XXX-NNN@rN y llegó ${JSON.stringify(supersedes)}`,
      "referenciá la revisión anterior completa, o null",
    );
    return;
  }
  if (ref.state !== undefined) {
    r.invalid(
      artifact,
      `'supersedes' lleva un anchor de estado (#${ref.state}) y supersede una REVISIÓN entera`,
      "quitá el anchor: se supersede la revisión, no uno de sus estados",
    );
    return;
  }
  const own = parseArtifactId(rawId);
  if (own !== null && (ref.package !== own.package || ref.artifact !== own.artifact)) {
    r.fail(
      "DESIGN_RELATION_BROKEN",
      artifact,
      `'supersedes' apunta a ${ref.package}/${ref.artifact} y este artefacto es ${rawId}`,
      "una revisión solo supersede a una revisión anterior de sí misma",
    );
    return;
  }
  if (isRevision(revision) && ref.revision >= revision) {
    r.fail(
      "DESIGN_RELATION_BROKEN",
      artifact,
      `'supersedes' apunta a r${ref.revision} y esta revisión es r${revision}`,
      "solo se supersede una revisión anterior",
    );
  }
}

function readTrace(r: Reader, front: Record<string, unknown>, artifact: string): TraceEntry[] {
  const out: TraceEntry[] = [];
  for (const entry of eachRecord(r, front, "trace", artifact, " de entradas de trazabilidad")) {
    const criterion = r.read(entry, "trace[].criterion");
    const source = r.read(entry, "trace[].source");
    if (
      !checkText(
        r,
        artifact,
        "trace[].criterion",
        criterion,
        "citá el acceptance criterion, por ejemplo S013/AC-SEM-11",
      )
    ) {
      continue;
    }
    if (
      source !== null &&
      source !== undefined &&
      !checkText(
        r,
        artifact,
        `trace[${criterion}].source`,
        source,
        "poné el path del documento que define el criterio, o null",
      )
    ) {
      continue;
    }
    out.push({ criterion, source: typeof source === "string" ? source : null });
  }
  return out;
}

function readUnknowns(r: Reader, front: Record<string, unknown>, artifact: string): UnknownEntry[] {
  const out: UnknownEntry[] = [];
  for (const entry of eachRecord(
    r,
    front,
    "unknowns",
    artifact,
    " (vacío si no quedan incógnitas)",
  )) {
    const question = r.read(entry, "unknowns[].question");
    const blocking = r.read(entry, "unknowns[].blocking");
    if (!isNonEmptyString(question)) {
      r.invalid(
        artifact,
        "cada entrada de 'unknowns' necesita 'question' no vacía",
        "escribí la incógnita como pregunta",
      );
      continue;
    }
    if (typeof blocking !== "boolean") {
      r.invalid(
        artifact,
        `unknowns['${question}']: 'blocking' debe ser true o false`,
        "declará si resolverla puede cambiar comportamiento o aceptación",
      );
      continue;
    }
    out.push({ question, blocking });
  }
  return out;
}

function readNotApplicable(
  r: Reader,
  front: Record<string, unknown>,
  artifact: string,
): Record<string, string> {
  const node = r.read(front, "not_applicable");
  if (node === undefined) {
    r.invalid(
      artifact,
      "falta 'not_applicable': el contrato la declara obligatoria",
      "escribí 'not_applicable: {}' si todo aplica",
    );
    return {};
  }
  if (node === null) return {};
  if (!isRecord(node)) {
    r.invalid(
      artifact,
      "'not_applicable' debe ser un mapping de sección a razón",
      "escribí 'not_applicable: {}' si todo aplica",
    );
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, reason] of Object.entries(node)) {
    out[key] = typeof reason === "string" ? reason : "";
  }
  return out;
}

/**
 * Non-applicability is a claim with a price: it names a CONDITIONAL section and
 * it states why. An essential section cannot be waived at all, and a reason left
 * empty is the same refusal to answer that "N/A" was.
 */
function checkNotApplicable(
  r: Reader,
  declared: Record<string, string>,
  kind: DesignDocKind,
  artifact: string,
): void {
  const allowed = conditionalKeys(kind);
  for (const [key, reason] of Object.entries(declared)) {
    if (!allowed.includes(key)) {
      r.fail(
        "DESIGN_NOT_APPLICABLE_FORBIDDEN",
        artifact,
        `'not_applicable.${key}' no es una sección condicional de ${kind} v1`,
        `solo estas admiten no-aplicabilidad: ${allowed.join(", ")}`,
      );
      continue;
    }
    if (reason.trim().length === 0 || PLACEHOLDER.test(reason.trim())) {
      r.fail(
        "DESIGN_NOT_APPLICABLE_NO_REASON",
        artifact,
        `'not_applicable.${key}' no explica por qué no aplica`,
        "escribí la razón; ni vacía ni 'N/A' satisfacen el contrato",
      );
    }
  }
}

interface FlowRead {
  actors: string[];
  entry: string;
  nodes: string[];
  edges: EdgeEntry[];
  dependencies: string[];
}

function readFlow(r: Reader, front: Record<string, unknown>, artifact: string): FlowRead {
  const actors = readStringList(r, front, "actors", artifact, "un actor");
  const nodes = readRefList(r, front, "nodes", artifact, "screen", true);
  const dependencies = readRefList(r, front, "dependencies", artifact, null);

  const entry = r.read(front, "entry");
  const entryRef = parseArtifactRef(entry);
  if (entryRef === null) {
    r.invalid(
      artifact,
      `'entry' debe ser el estado de pantalla por el que arranca el flow y llegó ${JSON.stringify(entry)}`,
      "escribí DES-NNN/SCR-NNN@rN#estado",
    );
  } else if (entryRef.state === undefined) {
    r.invalid(
      artifact,
      "'entry' debe apuntar a un ESTADO de pantalla",
      "agregá el anchor, por ejemplo @r2#default",
    );
  } else if (typeof entry === "string" && nodes.length > 0 && !nodes.includes(entry)) {
    r.fail(
      "DESIGN_RELATION_BROKEN",
      artifact,
      `'entry' (${entry}) no está en 'nodes'`,
      "el punto de entrada es uno de los nodos del grafo: agregalo a 'nodes'",
    );
  }

  const edges = readEdges(r, front, artifact, nodes);
  // With no nodes, every containment check above is vacuous — an edge could point
  // anywhere and nobody would say so. One diagnostic for the root cause beats a
  // pile of derived ones, and beats silence.
  if (nodes.length === 0 && (edges.length > 0 || typeof entry === "string")) {
    r.fail(
      "DESIGN_RELATION_BROKEN",
      artifact,
      "'nodes' está vacío y el flow declara entrada o transiciones",
      "enumerá en 'nodes' los estados de pantalla que el recorrido visita",
    );
  }
  return { actors, entry: typeof entry === "string" ? entry : "", nodes, edges, dependencies };
}

function readEdges(
  r: Reader,
  front: Record<string, unknown>,
  artifact: string,
  nodes: string[],
): EdgeEntry[] {
  const out: EdgeEntry[] = [];
  for (const entry of eachRecord(r, front, "edges", artifact, " de transiciones")) {
    const edge = readEdge(r, entry, artifact, nodes);
    if (edge !== null) out.push(edge);
  }
  return out;
}

function readEdge(
  r: Reader,
  entry: Record<string, unknown>,
  artifact: string,
  nodes: string[],
): EdgeEntry | null {
  const from = r.read(entry, "edges[].from");
  const trigger = r.read(entry, "edges[].trigger");
  const action = r.read(entry, "edges[].action");
  const condition = r.read(entry, "edges[].condition");
  const to = r.read(entry, "edges[].to");

  if (!isNonEmptyString(trigger)) {
    r.invalid(
      artifact,
      "cada arista necesita 'trigger' no vacío",
      "declará qué dispara la transición",
    );
    return null;
  }
  let ok = true;
  for (const [side, value] of [
    ["from", from],
    ["to", to],
  ] as const) {
    if (!checkEndpoint(r, artifact, trigger, side, value, nodes)) ok = false;
  }
  for (const [label, value] of [
    ["action", action],
    ["condition", condition],
  ] as const) {
    if (value === null || value === undefined || isNonEmptyString(value)) continue;
    r.invalid(
      artifact,
      `edges['${trigger}']: '${label}' debe ser texto o null`,
      `escribí ${label} o poné null`,
    );
    ok = false;
  }
  if (!ok) return null;
  return {
    from: from as string,
    trigger,
    action: typeof action === "string" ? action : null,
    condition: typeof condition === "string" ? condition : null,
    to: to as string,
  };
}

/**
 * The graph has to close on itself: an endpoint nobody declared as a node is a
 * transition into a screen the flow never says it visits.
 */
function checkEndpoint(
  r: Reader,
  artifact: string,
  trigger: string,
  side: "from" | "to",
  value: unknown,
  nodes: string[],
): boolean {
  const ref = parseArtifactRef(value);
  if (ref === null) {
    r.invalid(
      artifact,
      `edges['${trigger}']: '${side}' debe ser DES-NNN/SCR-NNN@rN#estado y llegó ${JSON.stringify(value)}`,
      "referenciá el estado de pantalla completo",
    );
    return false;
  }
  // Checked BEFORE membership: without it the author is told to add the
  // unanchored reference to `nodes`, which is the wrong fix for the real problem.
  if (ref.state === undefined) {
    r.invalid(
      artifact,
      `edges['${trigger}']: '${side}' (${String(value)}) apunta a una pantalla y una arista conecta ESTADOS`,
      "agregá el anchor del estado, por ejemplo @r2#default",
    );
    return false;
  }
  if (nodes.length > 0 && !nodes.includes(value as string)) {
    r.fail(
      "DESIGN_RELATION_BROKEN",
      artifact,
      `edges['${trigger}']: '${side}' (${String(value)}) no está en 'nodes'`,
      "agregá ese estado a 'nodes' o corregí la arista",
    );
    return false;
  }
  return true;
}

interface ScreenRead {
  title: string;
  default_state: string;
  states: StateEntry[];
  flow_refs: string[];
  dependencies: ScreenDependencies;
}

function readScreen(r: Reader, front: Record<string, unknown>, artifact: string): ScreenRead {
  const title = r.read(front, "title");
  checkText(r, artifact, "title", title, "poné el título profesional de la pantalla");

  const states = readStates(r, front, artifact);
  const anchors = states.map((s) => s.anchor);

  const defaultState = r.read(front, "default_state");
  if (!isNonEmptyString(defaultState)) {
    r.invalid(artifact, "'default_state' es obligatorio", "nombrá el anchor del estado base");
  } else if (states.length > 0 && !anchors.includes(defaultState)) {
    r.fail(
      "DESIGN_RELATION_BROKEN",
      artifact,
      `'default_state' es '${defaultState}' y no está entre los states declarados (${anchors.join(", ")})`,
      "declaralo en 'states' o apuntá a uno existente",
    );
  }

  if (states.length === 0) {
    r.invalid(
      artifact,
      "'states' está vacío: una screen sin estados no tiene nada direccionable",
      "declará al menos el estado base con su anchor y su propósito",
    );
  }

  const flowRefs = readRefList(r, front, "flow_refs", artifact, "flow");
  return {
    title: typeof title === "string" ? title : "",
    default_state: typeof defaultState === "string" ? defaultState : "",
    states,
    flow_refs: flowRefs,
    dependencies: readScreenDependencies(r, front, artifact),
  };
}

/**
 * Screen states. The anchor is what every flow, task and rendition addresses
 * (`DES-001/SCR-002@r2#empty`), so it has to be unique WITHIN THIS REVISION —
 * two states answering to one anchor make every reference to it ambiguous.
 */
function readStates(r: Reader, front: Record<string, unknown>, artifact: string): StateEntry[] {
  const out: StateEntry[] = [];
  const seen = new Set<string>();
  for (const entry of eachRecord(r, front, "states", artifact, " de estados")) {
    const anchor = r.read(entry, "states[].anchor");
    const purpose = r.read(entry, "states[].purpose");
    if (typeof anchor !== "string" || !ANCHOR_RE.test(anchor)) {
      r.invalid(
        artifact,
        `anchor de estado inválido: ${JSON.stringify(anchor)}`,
        "usá letras, números, guion y guion bajo, empezando por alfanumérico (default, empty, permission-denied)",
      );
      continue;
    }
    if (seen.has(anchor)) {
      r.fail(
        "DESIGN_ID_DUPLICATE",
        artifact,
        `el anchor de estado '${anchor}' está declarado dos veces`,
        "un anchor identifica un solo estado dentro de la revisión: renombrá el repetido",
      );
      continue;
    }
    seen.add(anchor);
    if (
      !checkText(
        r,
        artifact,
        `states['${anchor}'].purpose`,
        purpose,
        "escribí qué muestra ese estado",
      )
    ) {
      continue;
    }
    out.push({ anchor, purpose });
  }
  return out;
}

function readScreenDependencies(
  r: Reader,
  front: Record<string, unknown>,
  artifact: string,
): ScreenDependencies {
  const node = r.read(front, "dependencies");
  const empty: ScreenDependencies = { rules: [], tokens: [], assets: [] };
  if (!isRecord(node)) {
    r.invalid(
      artifact,
      "'dependencies' debe ser un objeto con 'rules', 'tokens' y 'assets'",
      "escribí las tres claves, con array vacío donde no haya dependencias",
    );
    return empty;
  }
  r.closed(node, "dependencies", artifact);
  return {
    rules: readRefList(r, node, "dependencies.rules", artifact, "rule"),
    tokens: readRefList(r, node, "dependencies.tokens", artifact, "token"),
    assets: readDigestList(r, node, "dependencies.assets", artifact),
  };
}

/** A list of exact artifact references, optionally constrained to one kind. */
function readRefList(
  r: Reader,
  node: Record<string, unknown>,
  path: string,
  artifact: string,
  kind: "screen" | "flow" | "rule" | "token" | null,
  requireAnchor = false,
): string[] {
  const raw = r.read(node, path);
  if (!Array.isArray(raw)) {
    r.invalid(artifact, `'${path}' debe ser un array de referencias`, `escribí '${path}': []`);
    return [];
  }
  const out: string[] = [];
  for (const value of raw) {
    if (!checkRef(r, artifact, path, value, kind, requireAnchor)) continue;
    if (out.includes(value as string)) {
      r.fail(
        "DESIGN_ID_DUPLICATE",
        artifact,
        `'${path}' repite ${String(value)}`,
        "dejá una sola aparición",
      );
      continue;
    }
    out.push(value as string);
  }
  return out;
}

/** One reference: well-formed, of the expected kind, and anchored or not as declared. */
function checkRef(
  r: Reader,
  artifact: string,
  path: string,
  value: unknown,
  kind: "screen" | "flow" | "rule" | "token" | null,
  requireAnchor: boolean,
): boolean {
  if (anchorIsTheProblem(value)) {
    r.invalid(
      artifact,
      `'${path}' referencia revisiones enteras y ${String(value)} lleva un anchor de estado`,
      "quitá el '#estado' de la referencia: solo una screen tiene estados",
    );
    return false;
  }
  const ref: ArtifactRef | null = parseArtifactRef(value);
  if (ref === null) {
    r.invalid(
      artifact,
      `'${path}' solo admite referencias DES-NNN/XXX-NNN@rN y llegó ${JSON.stringify(value)}`,
      "referenciá el artefacto completo, con package y revisión",
    );
    return false;
  }
  if (requireAnchor !== (ref.state !== undefined)) {
    r.invalid(
      artifact,
      requireAnchor
        ? `'${path}' referencia ESTADOS de pantalla y ${String(value)} no lleva anchor`
        : `'${path}' referencia revisiones enteras y ${String(value)} lleva un anchor de estado`,
      requireAnchor
        ? "agregá el anchor, por ejemplo @r2#default"
        : "quitá el '#estado' de la referencia",
    );
    return false;
  }
  const prefix = kind === null ? null : ARTIFACT_PREFIX[kind];
  if (prefix !== null && !ref.artifact.startsWith(`${prefix}-`)) {
    r.invalid(
      artifact,
      `'${path}' espera artefactos ${prefix}- y llegó ${String(value)}`,
      `referenciá un ${kind}`,
    );
    return false;
  }
  return true;
}

function readDigestList(
  r: Reader,
  node: Record<string, unknown>,
  path: string,
  artifact: string,
): string[] {
  const raw = r.read(node, path);
  if (!Array.isArray(raw)) {
    r.invalid(artifact, `'${path}' debe ser un array de digests`, `escribí '${path}': []`);
    return [];
  }
  const out: string[] = [];
  for (const value of raw) {
    if (!isDigest(value)) {
      r.invalid(
        artifact,
        `'${path}' referencia assets por digest y llegó ${JSON.stringify(value)}`,
        "usá 'sha256:' + 64 hex: los assets son content-addressed",
      );
      continue;
    }
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

function readStringList(
  r: Reader,
  node: Record<string, unknown>,
  path: string,
  artifact: string,
  what: string,
): string[] {
  const raw = r.read(node, path);
  if (!Array.isArray(raw)) {
    r.invalid(artifact, `'${path}' debe ser un array`, `escribí '${path}': []`);
    return [];
  }
  const out: string[] = [];
  for (const value of raw) {
    if (!checkText(r, artifact, `${path}[]`, value, `revisá '${path}': ${what}`)) continue;
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

/**
 * Cross-validation. Only the canonical reference form is extracted from the
 * body, so this never depends on interpreting prose: a mention the frontmatter
 * does not declare is either a typo or a relation nobody made machine-readable,
 * and both are errors.
 */
function checkBodyAgainstFrontmatter(
  r: Reader,
  body: ParsedBody,
  kind: DesignDocKind,
  artifact: string,
  common: CommonRead,
  specific: FlowRead | ScreenRead,
): void {
  checkBodyRefs(r, body, kind, artifact, common, specific);
  checkBodyCriteria(r, body, artifact, common);
  if ("states" in specific) checkBodyAssets(r, body, artifact, specific.dependencies.assets);
}

function checkBodyRefs(
  r: Reader,
  body: ParsedBody,
  kind: DesignDocKind,
  artifact: string,
  common: CommonRead,
  specific: FlowRead | ScreenRead,
): void {
  const declared = declaredReferences(common, specific);
  const own = parseArtifactId(common.id);
  const ownAnchors = "states" in specific ? specific.states.map((s) => s.anchor) : [];

  for (const ref of bodyReferences(body)) {
    const parsedRef = parseArtifactRef(ref);
    if (parsedRef === null) continue;
    if (own !== null && parsedRef.package === own.package && parsedRef.artifact === own.artifact) {
      // A reference to THIS artifact is legitimate without being declared — but
      // if it names a state, the state has to exist in this revision.
      checkOwnAnchor(r, artifact, kind, parsedRef.state, ownAnchors);
      continue;
    }
    if (declared.has(ref)) continue;
    r.fail(
      "DESIGN_BODY_REFERENCE_UNKNOWN",
      artifact,
      `el cuerpo cita ${ref} y el frontmatter no lo declara`,
      kind === "flow"
        ? "agregá esa referencia a 'nodes' o a 'dependencies', o quitala del texto"
        : "agregá esa referencia a 'flow_refs' o a 'dependencies', o quitala del texto",
    );
  }
}

/**
 * The spec asks for FOUR things to be contrasted, not one: references, states,
 * criteria and dependencies. A criterion narrated in the body and absent from
 * `trace` is traceability that exists only in prose — the exact thing the
 * frontmatter exists to prevent.
 */
function checkBodyCriteria(
  r: Reader,
  body: ParsedBody,
  artifact: string,
  common: CommonRead,
): void {
  const traced = new Set(common.trace.map((t) => t.criterion));
  for (const criterion of bodyCriteria(body)) {
    if (traced.has(criterion)) continue;
    r.fail(
      "DESIGN_BODY_CRITERION_UNKNOWN",
      artifact,
      `el cuerpo cita el criterio ${criterion} y 'trace' no lo declara`,
      "agregalo a 'trace' con su documento fuente, o quitalo del texto",
    );
  }
}

function checkBodyAssets(r: Reader, body: ParsedBody, artifact: string, declared: string[]): void {
  const assets = new Set(declared);
  for (const digest of bodyDigests(body)) {
    if (assets.has(digest)) continue;
    r.fail(
      "DESIGN_BODY_REFERENCE_UNKNOWN",
      artifact,
      `el cuerpo cita el asset ${digest} y 'dependencies.assets' no lo declara`,
      "agregá ese digest a 'dependencies.assets' o quitalo del texto",
    );
  }
}

function checkOwnAnchor(
  r: Reader,
  artifact: string,
  kind: DesignDocKind,
  state: string | undefined,
  ownAnchors: string[],
): void {
  if (kind !== "screen" || state === undefined || ownAnchors.includes(state)) return;
  r.fail(
    "DESIGN_RELATION_BROKEN",
    artifact,
    `el cuerpo cita el estado '#${state}' y 'states' no lo declara`,
    `declaralo en 'states' o citá uno de: ${ownAnchors.join(", ") || "(ninguno)"}`,
  );
}

/** Every reference the frontmatter makes machine-readable. */
function declaredReferences(common: CommonRead, specific: FlowRead | ScreenRead): Set<string> {
  const declared = new Set<string>();
  if (common.supersedes !== null) declared.add(common.supersedes);
  if ("nodes" in specific) {
    for (const ref of [...specific.nodes, ...specific.dependencies]) declared.add(ref);
    if (specific.entry.length > 0) declared.add(specific.entry);
    return declared;
  }
  for (const ref of [
    ...specific.flow_refs,
    ...specific.dependencies.rules,
    ...specific.dependencies.tokens,
  ]) {
    declared.add(ref);
  }
  return declared;
}
