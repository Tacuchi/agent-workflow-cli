import { join } from "node:path";
import { type DesignArtifact, validateDesignArtifact } from "../../domain/design/artifact.js";
import { computeClosure, notReadyForHandoff } from "../../domain/design/closure.js";
import {
  type ApprovalPolicy,
  type GovernanceRecord,
  judgeExecution,
  validateDesignReview,
  validateDesignRevocation,
} from "../../domain/design/governance.js";
import type { DesignFailure, DesignManifest } from "../../domain/design/manifest.js";
import {
  type SpecDesignReference,
  type TaskDesignReference,
  parseSpecDesignReferences,
  parseTaskDesignReferences,
} from "../../domain/design/reference.js";
import { reportRetiredDesign } from "../../domain/design/retired.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import { type DesignIndex, readDesignIndex } from "./design-index-service.js";
import {
  resolveBaselineOnDisk,
  resolveStateAnchor,
  resolveTaskReference,
  staleHintNotice,
} from "./design-resolver-service.js";

/**
 * The precondition gate `plan-exec` runs before implementing a task (AC-FLW-04).
 *
 * It composes what the earlier phases already built rather than re-deciding
 * anything: the reference resolver answers "does this still point at the same
 * bytes", governance answers "may this revision be executed", and the closure
 * answers "is what this task consumes actually implementable". This service's
 * only job is to ask all three per task and to fail CLOSED — a reference that
 * cannot be resolved blocks, it never degrades into a warning.
 *
 * The asymmetry between blocking and warning is the whole contract: a revision
 * somebody pinned on purpose stays executable after a newer one is published,
 * and only an explicit revocation takes it away. So `superseded` is a notice and
 * `revoked` is a failure, and no code path may collapse the two.
 */

export interface GateOwner {
  /** `task` when a `- [ ] Tn.m` line pins it, `phase` when the `### Fn` block does. */
  kind: "phase" | "task" | "document";
  /** `T3.2`, `F3`, or the plan path when the reference sits outside both. */
  label: string;
  /** 1-indexed, so a diagnostic can be opened where it was written. */
  line: number;
}

export interface GateVerdict {
  owner: GateOwner;
  /** The literal reference, as the author wrote it. */
  raw: string;
  /** False blocks execution of that task. Never true with failures present. */
  ready: boolean;
  notices: string[];
  failures: DesignFailure[];
}

export interface DesignGateReport {
  plan: string;
  /** True when anything blocks: no task of the plan gets implemented. */
  blocked: boolean;
  /** The `## Design references` the plan declares as its own. */
  declared: SpecDesignReference[];
  verdicts: GateVerdict[];
  /** Problems with the document itself rather than with one reference. */
  failures: DesignFailure[];
}

/**
 * Off by default (T7.3): `plan-exec` does not demand approval unless the
 * workspace asks for it, and turning it on never promotes or alters a maturity.
 */
export async function gatePlanDesign(
  fs: FileSystemPort,
  workspace: string,
  planPath: string,
  policy: ApprovalPolicy = { requireApproval: false },
): Promise<DesignGateReport> {
  const empty = { plan: planPath, declared: [], verdicts: [] };
  const absolute = join(workspace, planPath);
  if (!(await fs.exists(absolute))) {
    return {
      ...empty,
      blocked: true,
      failures: [
        {
          code: "DESIGN_GATE_PLAN_MISSING",
          artifact: planPath,
          message: `no existe '${planPath}'`,
          action: "pasá la ruta del plan relativa al workspace",
        },
      ],
    };
  }

  const text = await fs.readText(absolute);
  const declared = parseSpecDesignReferences(text, planPath);
  // ONE parse over the whole document, not one per line: the rule that a bare
  // `DES-001` is only prose when the same text pins it needs the whole text to
  // decide, and per-line it would report every prose mention of a pinned package.
  const pinned = parseTaskDesignReferences(text, planPath);
  // Legacy material is REPORTED here, at the gate, because this is where a
  // document is consumed as input and as a gate's evidence — the two things the
  // retired path is no longer allowed to be.
  const failures = [
    ...reportRetiredDesign(text, planPath),
    ...declared.failures,
    ...pinned.failures,
  ];

  if (pinned.references.length === 0) {
    // A plan with no design roots is the normal shape of a plan without UI. Its
    // own declared block is still reported if it is malformed.
    return { ...empty, declared: declared.references, blocked: failures.length > 0, failures };
  }

  const index = await readDesignIndex(fs, workspace);
  const packages = new PackageCache(fs, workspace, index);
  const verdicts: GateVerdict[] = [];
  for (const reference of pinned.references) {
    verdicts.push(
      await judgeReference(reference, {
        fs,
        workspace,
        index,
        packages,
        planPath,
        policy,
        declared: declared.references,
        owner: ownerOf(text, reference.raw, planPath),
      }),
    );
  }

  return {
    plan: planPath,
    blocked: failures.length > 0 || verdicts.some((v) => !v.ready),
    declared: declared.references,
    verdicts,
    failures,
  };
}

interface JudgeContext {
  fs: FileSystemPort;
  workspace: string;
  index: DesignIndex;
  packages: PackageCache;
  planPath: string;
  policy: ApprovalPolicy;
  declared: SpecDesignReference[];
  owner: GateOwner;
}

/** The three questions, in the only order that makes their answers meaningful. */
async function judgeReference(
  reference: TaskDesignReference,
  ctx: JudgeContext,
): Promise<GateVerdict> {
  const base: Omit<GateVerdict, "ready"> = {
    owner: ctx.owner,
    raw: reference.raw,
    notices: [],
    failures: [],
  };
  const blocked = (failure: DesignFailure): GateVerdict => ({
    ...base,
    ready: false,
    failures: [...base.failures, failure],
  });

  // 1. Does it still resolve to the same bytes?
  // The owner qualifies the plan only when it IS a phase or a task: for a
  // reference sitting in prose the label already is the plan, and naming it
  // twice reads as two artifacts.
  const artifact =
    ctx.owner.kind === "document" ? ctx.planPath : `${ctx.planPath} (${ctx.owner.label})`;
  const resolved = resolveTaskReference(ctx.index, reference, ctx.declared, artifact);
  if (!resolved.ok) return blocked(resolved.failure);

  const onDisk = await resolveBaselineOnDisk(ctx.fs, ctx.workspace, resolved.value, artifact);
  if (!onDisk.ok) return blocked(onDisk.failure);

  const anchored = await resolveStateAnchor(ctx.fs, ctx.workspace, resolved.value, artifact);
  if (!anchored.ok) return blocked(anchored.failure);

  const stale = staleHintNotice(resolved.value, artifact);
  if (stale !== null) base.notices.push(`${stale.message} → ${stale.action}`);

  const loaded = await ctx.packages.load(reference.baseline.package);
  if (loaded === null) {
    return blocked({
      code: "DESIGN_REFERENCE_PACKAGE_INVALID",
      artifact,
      message: `${reference.baseline.package} no tiene un manifest válido que resolver`,
      action: "corré 'aw designs --detail' y reparalo antes de ejecutar",
    });
  }

  // 2. May this exact revision be executed?
  const baselineRef = `${reference.baseline.package}@r${reference.baseline.revision}`;
  const verdict = judgeExecution(loaded.manifest, baselineRef, loaded.records, ctx.policy);
  base.notices.push(...verdict.notices);
  if (!verdict.executable) {
    return { ...base, ready: false, failures: [...base.failures, ...verdict.failures] };
  }

  // 3. Is what the task consumes implementable?
  //
  // A ROOT pin consumes the revision, not a node of a graph: there is no closure
  // to walk and no maturity ladder to climb. For a simple design that is the
  // whole truth — its content is one document the resolver already confirmed is
  // there, byte for byte. Running the package closure over it would demand a
  // `handoff` from artifacts that do not exist, which is exactly the "fingir
  // screens, flows o madurez" this route removes.
  if (reference.artifact === null) return { ...base, ready: true };

  const root = `${reference.artifact.package}/${reference.artifact.artifact}@r${reference.artifact.revision}`;
  const closure = computeClosure(loaded.manifest, [root], loaded.read);
  if (closure.failures.length > 0) {
    return { ...base, ready: false, failures: [...base.failures, ...closure.failures] };
  }
  const pending = notReadyForHandoff(loaded.manifest, closure);
  if (pending.length > 0) {
    return blocked({
      code: "DESIGN_HANDOFF_INCOMPLETE",
      artifact,
      message: `la clausura de ${root} alcanza ${pending.length} revisión(es) que no están en 'handoff': ${pending.map((p) => p.ref).join(", ")}`,
      action:
        "promové esa clausura a 'handoff' desde PLAN REFINE: plan-exec no rediseña ni completa un diseño incompleto",
    });
  }

  return { ...base, ready: true };
}

/**
 * Who pinned the reference. Attribution is by SEARCH over the document instead
 * of a second parse: the reference text is unique enough to locate, and a parser
 * that also had to track phase and task structure would be two contracts in one.
 *
 * The parse dedupes by literal text, so two tasks pinning the SAME root produce
 * one verdict, attributed to the first. Nothing escapes: `blocked` is plan-wide,
 * and the report is per reference rather than per task.
 */
function ownerOf(text: string, raw: string, planPath: string): GateOwner {
  const lines = text.split(/\r?\n/);
  let phase: string | null = null;
  let declaring = false;
  for (const [i, line] of lines.entries()) {
    // The `## Design references` block DECLARES; it never consumes. Skipping it
    // matters for a root pin, whose literal text (`DES-001@r1`) appears in the
    // declaration too — attributing the consumption there would point whoever
    // reads the diagnostic at the wrong line of the wrong section.
    if (/^##\s/.test(line)) declaring = line.trim() === "## Design references";
    if (declaring) continue;
    const heading = /^###\s+(F\d+)\b/.exec(line);
    if (heading !== null) phase = heading[1] as string;
    if (!line.includes(raw)) continue;
    const task = /^\s*-\s*\[[ xX]\]\s*(T[\d.]*\d)\b/.exec(line);
    if (task !== null) return { kind: "task", label: task[1] as string, line: i + 1 };
    if (phase !== null) return { kind: "phase", label: phase, line: i + 1 };
    return { kind: "document", label: planPath, line: i + 1 };
  }
  return { kind: "document", label: planPath, line: 0 };
}

interface LoadedPackage {
  manifest: DesignManifest;
  records: GovernanceRecord[];
  read: (path: string) => DesignArtifact | null;
}

/**
 * A package is read once per run.
 *
 * The closure needs a SYNCHRONOUS reader (it walks a graph and cannot await mid
 * traversal), so the catalog documents are pre-read into a map here. Reading
 * them per reference instead would re-read the same thirteen screens for every
 * task that touches the package.
 */
class PackageCache {
  private readonly loaded = new Map<string, LoadedPackage | null>();

  constructor(
    private readonly fs: FileSystemPort,
    private readonly workspace: string,
    private readonly index: DesignIndex,
  ) {}

  async load(id: string): Promise<LoadedPackage | null> {
    const cached = this.loaded.get(id);
    if (cached !== undefined) return cached;
    const value = await this.read(id);
    this.loaded.set(id, value);
    return value;
  }

  private async read(id: string): Promise<LoadedPackage | null> {
    const pkg = this.index.packages.find((p) => p.id === id);
    if (pkg === undefined || pkg.manifest === null) return null;
    const manifest = pkg.manifest;

    const documents = new Map<string, DesignArtifact>();
    for (const [key, kind] of [
      ["flows", "flow"],
      ["screens", "screen"],
    ] as const) {
      for (const entry of manifest.catalog[key]) {
        const absolute = join(this.workspace, pkg.path, entry.path);
        if (!(await this.fs.exists(absolute))) continue;
        const parsed = validateDesignArtifact(await this.fs.readText(absolute), kind, entry.path);
        if (parsed.ok && parsed.value !== null) documents.set(entry.path, parsed.value);
      }
    }

    return {
      manifest,
      records: await this.readRecords(manifest, pkg.path),
      read: (path) => documents.get(path) ?? null,
    };
  }

  /**
   * Records are read through the paths the MANIFEST indexes, never by globbing
   * `governance/`: the manifest is the normative index, and a file it does not
   * index is not a decision anybody registered.
   */
  private async readRecords(
    manifest: DesignManifest,
    packagePath: string,
  ): Promise<GovernanceRecord[]> {
    const records: GovernanceRecord[] = [];
    for (const [entries, validate] of [
      [manifest.governance.reviews, validateDesignReview],
      [manifest.governance.revocations, validateDesignRevocation],
    ] as const) {
      for (const entry of entries) {
        const absolute = join(this.workspace, packagePath, entry.path);
        if (!(await this.fs.exists(absolute))) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(await this.fs.readText(absolute));
        } catch {
          continue;
        }
        // An invalid record is NOT a decision: a malformed revocation must not
        // block, and a malformed approval must not approve. Package validation
        // is where its shape gets reported.
        const validation = validate(parsed, entry.path);
        if (validation.ok && validation.value !== null) records.push(validation.value);
      }
    }
    return records;
  }
}
