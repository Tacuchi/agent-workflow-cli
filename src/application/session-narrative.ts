/**
 * Build the session's narrative by reading each fact from the artifact that owns
 * it — and write it back as the managed block.
 *
 * The gathering is deliberately dull: one artifact per kind of fact, no
 * cross-checking, no reconciliation, no preference between two sources that
 * disagree. There is nothing to reconcile, because no fact has two owners. The
 * objective is `SESSION.md`'s; progress is `CHECKPOINT.md`'s; the reasons are
 * `DECISION.md`'s; what really executed is the run state's. When one of them is
 * absent the narrative is simply shorter — never filled in from a neighbour.
 *
 * Reading NEVER writes. `buildSessionNarrative` opens files and returns a value;
 * the block is written only by {@link writeSessionNarrative}, which the session's
 * own mutations call. A legacy session therefore projects fine and stays exactly
 * as it is on disk, which is what "los artefactos históricos se preservan" has to
 * mean if it means anything.
 */

import { join } from "node:path";
import {
  NARRATIVE_BEGIN,
  type NarrativeFact,
  type NarrativeSource,
  type SessionNarrative,
  type SessionPhase,
  renderNarrativeBlock,
  stripNarrativeBlock,
  upsertNarrativeBlock,
} from "../domain/session/narrative.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { PLACEHOLDER_MARKER, readCheckpointNarrative } from "./checkpoint-service.js";
import { projectRun } from "./flow/run-projection.js";
import { locateRun, readRun } from "./flow/run-state-service.js";
import { firstNonEmptyLine, parseMdSectionBilingual } from "./markdown.js";
import { parseDecisiones } from "./parsers/decisiones.js";
import type { PathsService } from "./paths-service.js";
import { type ArtifactKind, canonicalArtifactFilename, findArtifact } from "./session-artifacts.js";
import { CLOSED_MARKER, sessionNumericCode } from "./session-resolver.js";

/** One `- [ ]` / `- [x]` item, or `null` for a line that is not one. */
const CHECKLIST = /^[ \t]*[-*][ \t]+\[([ xX]?)\][ \t]*(\S.*)$/;

/** A bulleted or plain line worth surfacing, trimmed of its bullet. */
const BULLET = /^[ \t]*(?:[-*][ \t]+)?(\S.*)$/;

/** How many lines of a prose section reach the narrative. */
const SECTION_LIMIT = 6;

export interface NarrativeInput {
  folder: string;
  path: string;
  /** Absent lets the builder derive it from the folder name. */
  code?: string | null;
}

export async function buildSessionNarrative(
  fs: FileSystemPort,
  paths: PathsService,
  input: NarrativeInput,
): Promise<SessionNarrative> {
  const authored = await readAuthored(fs, input.path);
  const checkpoint = await readCheckpointNarrative(fs, input.path);
  const closed = await fs.exists(join(input.path, CLOSED_MARKER));
  const run = await projectRun(fs, paths, input.folder);
  const { sequence, evidence } = await materialTrace(fs, paths, input.folder);

  const results = fromCheckpoint(checkpoint?.completed, "aplicado", "Completed");
  const pending = [
    ...fromCheckpoint(checkpoint?.pending, "planificado", "Pending / Next"),
    ...fromCheckpoint(checkpoint?.openQuestions, "planificado", "Open questions"),
  ];

  return {
    session: input.folder,
    code: input.code ?? sessionNumericCode(input.folder),
    phase: phaseOf(closed, results.length > 0),
    objective: authored.objective,
    sequence,
    tasks: authored.tasks,
    decisions: await readDecisions(fs, input.path),
    results,
    evidence,
    pending,
    // The run's boundary outranks the CHECKPOINT's prose for the same reason
    // `resume` already prefers it: it names the transition in force and, when
    // something has to run, the exact invocation. The CHECKPOINT's own next line
    // stays available as a pending fact, so nothing is lost by preferring it.
    next:
      run !== null && run.boundary !== "final"
        ? { state: "planificado", text: run.summary, detail: run.transition, source: RUN_SOURCE }
        : (pending[0] ?? null),
    links: await linksOf(fs, input.path),
  };
}

/** The objective and the done-condition — the two facts the session document owns. */
async function readAuthored(
  fs: FileSystemPort,
  sessionPath: string,
): Promise<{ objective: NarrativeFact | null; tasks: NarrativeFact[] }> {
  const file =
    (await findArtifact(sessionPath, "session", fs)) ??
    (await findArtifact(sessionPath, "objective", fs));
  if (file === null || file === undefined) return { objective: null, tasks: [] };
  // The managed block is stripped before anything is read out of the document: a
  // projection that fed on its own previous output would drift a little further
  // from its sources on every write, and nobody could tell which line was real.
  const text = stripNarrativeBlock(await fs.readText(file));
  const artifact = basename(file);
  return {
    objective: factOf(parseMdSectionBilingual(text, "Objective"), "aplicado", {
      artifact,
      locator: "Objective",
    }),
    tasks: checklistFacts(parseMdSectionBilingual(text, "Success criteria"), {
      artifact,
      locator: "Success criteria",
    }),
  };
}

/** One CHECKPOINT section as facts, attributed to the heading it came from. */
function fromCheckpoint(
  section: string | null | undefined,
  state: NarrativeFact["state"],
  locator: string,
): NarrativeFact[] {
  return bulletFacts(section ?? null, state, { artifact: "CHECKPOINT.md", locator });
}

async function readDecisions(fs: FileSystemPort, sessionPath: string): Promise<NarrativeFact[]> {
  const file = await findArtifact(sessionPath, "decisions", fs);
  if (file === null || file === undefined) return [];
  return decisionFacts(await fs.readText(file), basename(file));
}

const RUN_SOURCE: NarrativeSource = { artifact: ".flow-run.json", locator: "boundary" };

/**
 * Open, resumed or closed — derived from what is on disk.
 *
 * "Resumed" is not a flag anybody sets: a session that already recorded completed
 * work and is still open has been left and picked up, which is exactly the state a
 * reader needs told apart from a session that has not started. Deriving it keeps
 * it from becoming a second truth somebody has to remember to update.
 */
function phaseOf(closed: boolean, hasProgress: boolean): SessionPhase {
  if (closed) return "cerrada";
  return hasProgress ? "reanudada" : "abierta";
}

/**
 * The phase, from a session folder — the one rule, for every surface that asks.
 *
 * The board used to derive it with its own "is `Completed` non-empty?" check,
 * which is the same question asked in a way that could answer differently: a
 * CHECKPOINT holding only unfilled placeholders is non-empty and is not progress.
 * One function, so `aw status` and the session's own entry point cannot disagree
 * about whether anybody has come back to it.
 */
export async function readSessionPhase(
  fs: FileSystemPort,
  sessionPath: string,
  closed: boolean,
): Promise<SessionPhase> {
  if (closed) return "cerrada";
  const checkpoint = await readCheckpointNarrative(fs, sessionPath);
  const progress = fromCheckpoint(checkpoint?.completed, "aplicado", "Completed");
  return phaseOf(false, progress.length > 0);
}

/**
 * What really executed, from the run state's own trace.
 *
 * The only part of the narrative that is not prose somebody wrote: an `executed`
 * event says a step ran with real output and which evidence it satisfied, and a
 * `failed` one says what stopped and what unblocks it. Nothing else in a session
 * folder can answer "did it actually happen?", which is why the trace exists.
 */
async function materialTrace(
  fs: FileSystemPort,
  paths: PathsService,
  folder: string,
): Promise<{ sequence: NarrativeFact[]; evidence: NarrativeFact[] }> {
  const read = await readRun(fs, locateRun(paths, folder));
  if (!read.ok) return { sequence: [], evidence: [] };
  const sequence: NarrativeFact[] = [];
  const evidence: NarrativeFact[] = [];
  for (const event of read.state.events) {
    const source: NarrativeSource = { artifact: ".flow-run.json", locator: event.transition };
    if (event.kind === "executed") {
      sequence.push({
        state: "aplicado",
        text: event.summary,
        detail: `${event.transition} · efectos ${event.effects.join(", ")}`,
        source,
      });
      evidence.push({
        state: "aplicado",
        // The sentence says WHAT was proven; the ids and the seal that prove it
        // wait for `--detail`. Both halves are real — only one of them is what a
        // person reads to decide.
        text: `quedó registrada la salida real de ${event.operation}`,
        detail: `${event.evidence.join(", ")} · salida ${event.output_digest.slice(0, 12)} · efectos ${event.effects.join(", ")}`,
        source,
      });
      continue;
    }
    if (event.kind === "reconciled") {
      // A repair nobody was asked about still belongs in the account of what
      // happened — as something already applied, never as a pending step.
      sequence.push({
        state: "aplicado",
        text: `la corrida reparó su propia contabilidad en ${event.transition}: ${event.repairs
          .map((repair) => repair.rule)
          .join(", ")}`,
        detail: event.repairs
          .map((repair) => `${repair.field} ${repair.before} → ${repair.after} (${repair.cause})`)
          .join(" · "),
        source,
      });
      continue;
    }
    sequence.push({
      state: "fallido",
      text: `${event.message} — ${event.recovery}`,
      detail: `${event.transition} · ${event.code}`,
      source,
    });
  }
  return { sequence, evidence };
}

/** The artifacts that exist, so the technical detail is one hop from the block. */
async function linksOf(
  fs: FileSystemPort,
  sessionPath: string,
): Promise<SessionNarrative["links"]> {
  const kinds: ArtifactKind[] = [
    "checkpoint",
    "decisions",
    "conclusions",
    "analysis_file",
    "backlog",
    "scripts_sql",
    "tasks",
  ];
  const links: SessionNarrative["links"] = [];
  for (const kind of kinds) {
    const found = await findArtifact(sessionPath, kind, fs);
    if (found === null || found === undefined) continue;
    const name = basename(found);
    links.push({ label: name, path: `./${name}` });
  }
  return links;
}

function factOf(
  text: string | undefined,
  state: NarrativeFact["state"],
  source: NarrativeSource,
): NarrativeFact | null {
  const first = text === undefined ? undefined : firstNonEmptyLine(text);
  if (first === undefined || first.trim().length === 0) return null;
  return { state, text: first.trim(), detail: null, source };
}

/** One fact per checklist item: an unticked box is planned, a ticked one applied. */
function checklistFacts(section: string | undefined, source: NarrativeSource): NarrativeFact[] {
  if (section === undefined) return [];
  const facts: NarrativeFact[] = [];
  for (const raw of section.split("\n")) {
    const match = CHECKLIST.exec(raw);
    if (match === null) continue;
    const text = (match[2] ?? "").trim();
    if (text.length === 0) continue;
    facts.push({
      state: match[1]?.toLowerCase() === "x" ? "aplicado" : "planificado",
      text,
      detail: null,
      source,
    });
  }
  return facts;
}

/** The section's own lines, capped — the block is an entry point, not a copy. */
function bulletFacts(
  section: string | null,
  state: NarrativeFact["state"],
  source: NarrativeSource,
): NarrativeFact[] {
  if (section === null) return [];
  const facts: NarrativeFact[] = [];
  for (const raw of section.split("\n")) {
    if (facts.length >= SECTION_LIMIT) break;
    const match = BULLET.exec(raw);
    const text = match?.[1]?.trim();
    if (text === undefined || text.length === 0 || text.startsWith("<!--")) continue;
    // An unfilled placeholder is the template, not progress. Surfacing it would
    // let a CHECKPOINT nobody wrote read as a session that got somewhere — and
    // it is what makes a half-written session look resumed.
    if (text.includes(PLACEHOLDER_MARKER)) continue;
    facts.push({ state, text, detail: null, source });
  }
  return facts;
}

/**
 * A decision and the reason it carries, from the parser that already knows both
 * shapes a `DECISION.md` is written in.
 *
 * Reusing {@link parseDecisiones} rather than reading the file again is the same
 * rule the rest of this module follows: the count `session-artifacts` reports and
 * the decisions the narrative lists come from ONE reading, so a file cannot show
 * three decisions in one surface and none in the other.
 */
function decisionFacts(text: string, artifact: string): NarrativeFact[] {
  return parseDecisiones(text).map((decision) => ({
    state: "aplicado" as const,
    text: decision.preview === null ? decision.title : `${decision.title} — ${decision.preview}`,
    detail: decision.graduated ? "graduada" : null,
    source: { artifact, locator: decision.id },
  }));
}

function basename(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

/** Whether the narrative carries a fact that does not live in `SESSION.md`. */
function addsAnything(narrative: SessionNarrative): boolean {
  return (
    narrative.sequence.length > 0 ||
    narrative.results.length > 0 ||
    narrative.decisions.length > 0 ||
    narrative.pending.length > 0 ||
    narrative.evidence.length > 0
  );
}

/**
 * Write the narrative into `SESSION.md`, as the session's own mutation.
 *
 * Called by the writes that change what the narrative says — creating the session
 * and closing it — and by nothing that only reads. Absent `SESSION.md` is not an
 * error: a legacy session keeps its `OBJECTIVE.md` and gets no block, because
 * creating one would be this projection rewriting history to look like itself.
 */
export async function writeSessionNarrative(
  fs: FileSystemPort,
  paths: PathsService,
  input: NarrativeInput,
): Promise<boolean> {
  const file = join(input.path, canonicalArtifactFilename("session"));
  if (!(await fs.exists(file))) return false;
  const narrative = await buildSessionNarrative(fs, paths, input);
  const document = await fs.readText(file);
  // A brand-new session has nothing to narrate that the document above does not
  // already say — its objective and its criteria ARE the entry point at that
  // point. Writing the block anyway would add, to every session at the moment it
  // has least to tell, a copy of the two sections right above it. The block earns
  // its place once something happened outside `SESSION.md`.
  //
  // That is a rule about CREATING the block, never about refreshing one: a
  // document that already carries it has a reader trusting it, and a block left
  // declaring a state the session no longer has is worse than a thin one.
  if (!document.includes(NARRATIVE_BEGIN) && !addsAnything(narrative)) return false;
  const next = upsertNarrativeBlock(document, renderNarrativeBlock(narrative));
  if (next === document) return false;
  await fs.writeText(file, next);
  return true;
}
