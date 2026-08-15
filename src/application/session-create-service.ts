import { join } from "node:path";
import { CORRELATIVE_SOURCE } from "../domain/correlative.js";
import { type CoreDocsCanon, coreDocumentDirectory } from "../domain/docs-canon.js";
import { checkSafeRelativePath } from "../domain/safe-path.js";
import type { CustodyArtifact } from "../domain/session/custody.js";
import type { SessionType } from "../domain/types.js";
import { type WorklineNodeId, nodeFromDocPath } from "../domain/workline-node.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { localDateIso } from "./dates.js";
import { resolveCoreDocsCanon } from "./docs-canon-service.js";
import { withCwdLock } from "./lock-service.js";
import type { PathsService } from "./paths-service.js";
import { canonicalArtifactPath } from "./session-artifacts.js";
import { bindContextToSession, readBindingRegistry } from "./session-binding-service.js";
import { baselineOf, birthCustody, custodyPath, writeCustody } from "./session-custody-service.js";
import { nextSessionCorrelative } from "./session-resolver.js";
import { renderSessionMarkdown } from "./templates/session.js";

const VALID_TYPES = ["research", "refine", "exec", "quick"] as const;

export interface SessionCreateInput {
  type?: string;
  name?: string;
  objetivo?: string;
  /** Optional plain origin string (who/where the session was created from). */
  originRaw?: string;
  /** Opaque conversation id; the new session becomes its associated line. */
  contextId?: string;
  /**
   * Workspace-relative artifacts the run RECEIVES and may modify.
   *
   * Declared at creation because that is the only moment their previous bytes
   * still exist to be sealed. A run that names its input here can be reset to the
   * exact state it started from; one that does not can only ever be discarded,
   * and `discard/reset prepare` says so instead of guessing.
   */
  inputs?: readonly string[];
}

export interface SessionCreateRecordOutput {
  type: SessionType;
  name: string;
  /** Global sequential number assigned by the CLI (zero-padded, e.g. "003"). */
  number: string;
  folder: string;
  path: string;
  session_path: string;
  /** Where the sealed custody landed — the run's baseline, not a human artifact. */
  custody_path: string;
  /** Declared inputs whose previous state the custody now holds. */
  inputs: string[];
  /**
   * Where `inputs` came from.
   *
   * `declared` — the caller passed `--input`, and the caller is authoritative.
   * `derived` — the CLI read the run's own document off its descriptor.
   * `none` — the custody holds no baseline, and `inputs_note` says why.
   */
  inputs_from: InputsOrigin;
  /** Why nothing was sealed, whenever the flow DID have a document to look for. */
  inputs_note?: string;
  origin?: string;
}

export type InputsOrigin = "declared" | "derived" | "none";

export interface SessionCreateFullOutput {
  sessionCreate: SessionCreateRecordOutput;
}

export interface SessionCreateError {
  error: string;
  expected?: string[];
  code?: string;
}

export async function runSessionCreate(
  fs: FileSystemPort,
  paths: PathsService,
  input: SessionCreateInput,
): Promise<SessionCreateFullOutput | SessionCreateError> {
  const validated = validateInput(input);
  if ("error" in validated) return validated;
  const { type, name, objetivo } = validated;

  // The session's custody is a lifecycle reader of the core document graph.
  // Resolve it before looking for a derived input; a malformed or relocated
  // core canon must not silently make a session with an empty baseline.
  const resolvedCanon = await resolveCoreDocsCanon(fs, paths);
  if (!resolvedCanon.ok) {
    return { error: resolvedCanon.error, code: "DOCS_CANON_INVALID" };
  }

  const declared = input.inputs ?? [];
  const derived =
    declared.length > 0
      ? EMPTY_DERIVATION
      : await deriveInputs(fs, paths, name, resolvedCanon.canon);

  // Baselines are read BEFORE the claim so the bytes sealed are the ones that
  // existed before this session could touch anything, and a declared input that
  // cannot be read fails the creation instead of producing a custody that
  // pretends to know what it received.
  const baselines = await readBaselines(fs, paths, declared.length > 0 ? declared : derived.paths);
  if ("error" in baselines) return baselines;

  const folderInfo = await claimSessionFolder(
    fs,
    paths,
    name,
    input.contextId,
    baselines.artifacts,
    resolvedCanon.canon,
  );
  if ("error" in folderInfo) return folderInfo;

  const sessionPath = folderInfo.sessionPath;
  const origin = input.originRaw?.trim();
  const sessionFilePath = canonicalArtifactPath(sessionPath, "session");
  await fs.writeText(
    sessionFilePath,
    renderSessionMarkdown({
      name,
      type,
      objetivo,
      ...(origin && origin.length > 0 ? { origin } : {}),
    }),
  );

  const record: SessionCreateRecordOutput = {
    type,
    name,
    number: folderInfo.number,
    folder: folderInfo.folder,
    path: sessionPath,
    session_path: sessionFilePath,
    custody_path: folderInfo.custodyPath,
    inputs: baselines.artifacts.map((a) => a.path),
    inputs_from: originOf(declared, derived),
  };
  if (derived.note !== undefined) record.inputs_note = derived.note;
  if (origin && origin.length > 0) record.origin = origin;

  return { sessionCreate: record };
}

/**
 * The document each embarked flow RECEIVES, keyed by the suffix its descriptor
 * carries.
 *
 * The five command skills open their session with `--name <slug>-<flow>` and none
 * of them passes `--input`, so every session born through the documented protocol
 * used to declare zero artifacts — and a `reset` over one of those restored
 * nothing while reporting success. Making the skills pass the path would put the
 * contract in a place that can forget it: a skill is prose, five copies of it
 * drift, and the bundle it lives in is at its context ceiling. The CLI already
 * owns both spellings — the folder is `NNN-<slug>-<flow>` and the document is
 * `docs/<dir>/NNN-<kind>-<slug>.md` — so it derives what it already knows.
 *
 * `plan-new` reads from `specs` and not from `plans` on purpose: it WRITES its
 * plan, whose number does not exist yet, so what it receives is the spec it
 * derives from. `quick` is absent because a quick works on no document.
 */
const FLOW_INPUTS: ReadonlyArray<{ flow: string; kind: "spec" | "plan" }> = [
  { flow: "spec-refine", kind: "spec" },
  { flow: "plan-new", kind: "spec" },
  { flow: "plan-refine", kind: "plan" },
  { flow: "plan-exec", kind: "plan" },
];

interface Derivation {
  paths: string[];
  /** Present only when a flow HAD a document to find and it was not found once. */
  note?: string;
}

const EMPTY_DERIVATION: Derivation = { paths: [] };

/**
 * The run's input document, read off its own descriptor — or the reason there is
 * none.
 *
 * Never guesses: a slug that answers to two documents leaves the custody empty
 * and SAYS so, because sealing the baseline of the wrong plan is worse than
 * sealing none — a later `reset` would put somebody else's bytes back.
 */
async function deriveInputs(
  fs: FileSystemPort,
  paths: PathsService,
  name: string,
  canon: CoreDocsCanon,
): Promise<Derivation> {
  const descriptor = sessionDescriptor(name);
  const flow = FLOW_INPUTS.find((f) => descriptor.endsWith(`-${f.flow}`));
  if (flow === undefined) return EMPTY_DERIVATION;
  const slug = descriptor.slice(0, -(flow.flow.length + 1));
  if (slug.length === 0) return EMPTY_DERIVATION;

  const relativeDir = coreDocumentDirectory(canon, flow.kind);
  const wanted = new RegExp(`^${CORRELATIVE_SOURCE}-${flow.kind}-${escapeRegExp(slug)}\\.md$`, "i");
  const found = await listNames(fs, join(paths.workspaceDir(), relativeDir), wanted);
  const only = found.length === 1 ? found[0] : undefined;
  if (only !== undefined) return { paths: [`${relativeDir}/${only}`] };
  return {
    paths: [],
    note:
      found.length === 0
        ? `la custodia nace sin entradas: no hay ningún '${relativeDir}/NNN-${flow.kind}-${slug}.md' que sellar`
        : `la custodia nace sin entradas: '${slug}' responde a ${found.length} documentos (${found.join(", ")}) y el CLI no elige por vos; volvé a crearla con --input <ruta>`,
  };
}

/** Filenames of `dir` matching `re`, sorted; an unreadable directory has none. */
async function listNames(fs: FileSystemPort, dir: string, re: RegExp): Promise<string[]> {
  if (!(await fs.exists(dir))) return [];
  try {
    return (await fs.list(dir))
      .filter((entry) => entry.type === "file" && re.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function originOf(declared: readonly string[], derived: Derivation): InputsOrigin {
  if (declared.length > 0) return "declared";
  return derived.paths.length > 0 ? "derived" : "none";
}

type Baselines = { artifacts: CustodyArtifact[] } | SessionCreateError;

/**
 * The sealed previous state of every declared input, or the refusal.
 *
 * The path guard is the workspace's own (`checkSafeRelativePath`), the same one
 * every other write boundary uses: a second, hand-rolled version of "is this
 * relative" is how two boundaries end up disagreeing about which paths are
 * allowed. A repeated input is collapsed rather than sealed twice — the baseline
 * of a path is one fact.
 */
async function readBaselines(
  fs: FileSystemPort,
  paths: PathsService,
  inputs: readonly string[],
): Promise<Baselines> {
  const artifacts: CustodyArtifact[] = [];
  const root = paths.workspaceDir();
  for (const raw of inputs) {
    const safe = checkSafeRelativePath(raw);
    if (!safe.ok) {
      return {
        error: `--input '${raw}' tiene que ser una ruta relativa al workspace: ${safe.why}`,
        code: "INVALID_INPUT",
      };
    }
    if (artifacts.some((a) => a.path === safe.path)) continue;
    try {
      artifacts.push(await baselineOf(fs, root, safe.path));
    } catch (err) {
      return {
        error: `no se pudo sellar el estado previo de '${safe.path}': ${err instanceof Error ? err.message : String(err)}`,
        code: "CUSTODY_BASELINE_UNREADABLE",
      };
    }
  }
  return { artifacts };
}

/**
 * The `--name` a caller passed, with any leading `NNN-` normalized away.
 *
 * Shared by the folder claim and the input derivation because both read the same
 * descriptor: if only one of them normalized, a `--name 028-x-plan-exec` would
 * land in folder `007-x-plan-exec` while its document was looked up under the
 * slug `028-x`.
 */
function sessionDescriptor(name: string): string {
  return name.replace(new RegExp(`^${CORRELATIVE_SOURCE}-`), "");
}

interface ValidatedInput {
  type: SessionType;
  name: string;
  objetivo: string;
}

function validateInput(input: SessionCreateInput): ValidatedInput | SessionCreateError {
  const type = input.type?.trim().toLowerCase();
  if (!type) {
    return {
      error: "--type es obligatorio (research|refine|exec|quick)",
      expected: [...VALID_TYPES],
    };
  }
  if (!(VALID_TYPES as readonly string[]).includes(type)) {
    return {
      error: `--type inválido '${type}'; esperado research|refine|exec|quick`,
      expected: [...VALID_TYPES],
    };
  }
  const name = input.name?.trim();
  if (!name) return { error: "--name es obligatorio" };
  const objetivo = input.objetivo?.trim();
  if (!objetivo) return { error: "--objetivo es obligatorio" };
  return { type: type as SessionType, name, objetivo };
}

interface FolderInfo {
  folder: string;
  number: string;
  sessionPath: string;
  custodyPath: string;
}

/**
 * Claim number + folder + custody + conversation association under ONE lock: two
 * concurrent creations must not read the same counter and race for the same
 * `NNN`, and the new line must belong to its conversation — and hold its sealed
 * baseline — the moment it exists.
 *
 * The custody is written INSIDE the critical section for the same reason the
 * number is minted there: a session that becomes visible before its baseline is
 * sealed is a session another process can start driving, and the first mutation
 * would then land against a custody nobody had written yet.
 */
async function claimSessionFolder(
  fs: FileSystemPort,
  paths: PathsService,
  name: string,
  contextId: string | undefined,
  artifacts: readonly CustodyArtifact[],
  canon: CoreDocsCanon,
): Promise<FolderInfo | SessionCreateError> {
  const id = contextId?.trim() ?? "";
  // `failure` (not `error`) so the busy-lock envelope `withCwdLock` returns
  // stays distinguishable from a failure raised inside the critical section.
  type Locked = { ok: true; info: FolderInfo } | { ok: false; failure: SessionCreateError };

  const result = await withCwdLock(fs, paths, async (): Promise<Locked> => {
    // Fail before creating anything when the registry cannot be read: a session
    // that exists but could not be associated is worse than one never created.
    if (id.length > 0) {
      const registry = await readBindingRegistry(fs, paths);
      if (!registry.ok) {
        return {
          ok: false,
          failure: { error: registry.reason, code: "SESSION_BINDING_INVALID" },
        };
      }
    }
    const sessionsDir = paths.cwdSessionsDir();
    await fs.mkdirp(sessionsDir);
    // The CLI owns the session number: a single global, sequential counter across
    // ALL sessions in `.workflow/sessions/` (any type), so numbering never resets
    // per type nor collides. Callers pass only the descriptor via `--name`; the
    // `NNN-` prefix is assigned here.
    const descriptor = sessionDescriptor(name);
    // The same derivation `aw sessions` publishes: the number that gets
    // announced has to be the number that gets assigned.
    const number = await nextSessionCorrelative(fs, paths);
    const folder = `${number}-${descriptor}`;
    const sessionPath = join(sessionsDir, folder);
    if (await fs.exists(sessionPath)) {
      return { ok: false, failure: { error: `Ya existe ${sessionPath}` } };
    }
    await fs.mkdirp(sessionPath);
    await writeCustody(
      fs,
      sessionPath,
      birthCustody({
        subject: { kind: "session", key: folder },
        subjectPath: sessionPath,
        parents: parentsOf(artifacts, canon),
        artifacts,
        created: localDateIso(new Date()),
      }),
    );
    if (id.length > 0) await bindContextToSession(fs, paths, id, folder);
    return {
      ok: true,
      info: { folder, number, sessionPath, custodyPath: custodyPath(sessionPath) },
    };
  });

  if ("error" in result) return { error: result.error, code: "LOCK_BUSY" };
  return result.ok ? result.info : result.failure;
}

/**
 * The typed parents a set of declared inputs implies.
 *
 * An input is the document the run works ON, so the document IS its parent — and
 * the edge is provable, because the path was declared by the caller and its
 * identity is fixed by the workspace layout. An input that names no spec or plan
 * (a checkpoint, a loose file) contributes no parent rather than a guessed one.
 */
function parentsOf(artifacts: readonly CustodyArtifact[], canon: CoreDocsCanon): WorklineNodeId[] {
  const parents: WorklineNodeId[] = [];
  for (const artifact of artifacts) {
    const node = nodeFromDocPath(artifact.path, canon);
    if (node === null) continue;
    if (parents.some((p) => p.kind === node.kind && p.key === node.key)) continue;
    parents.push(node);
  }
  return parents;
}
