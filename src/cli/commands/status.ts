import {
  type PipelineItem,
  type StatusOutput,
  runStatusCommand,
} from "../../application/status-service.js";
import {
  type IndexedPlan,
  type IndexedSpec,
  planPresentation,
  specDetail,
} from "../../application/workline-index-service.js";
import type { CommandResult } from "../../domain/types.js";
import { type ParsedArgs, flagValue } from "../parser.js";
import type { CliCommand, HumanRenderContext } from "../registry.js";
import { fail } from "../render.js";
import type { CliContext } from "../types.js";

/** One document of the board: the same item `--detail` lists, with nothing around it. */
export type StatusDocumentOutput = Pick<StatusOutput, "hub" | "last_activity"> &
  ({ plan: IndexedPlan } | { spec: IndexedSpec });

type StatusCommandOutput = StatusOutput | StatusDocumentOutput;

export const statusCommand: CliCommand<StatusCommandOutput> = {
  name: "status",
  flags: { known: ["plan", "spec"] },
  help: {
    purpose: "Show what is pending in the hub: specs, plans, sessions and discarded work.",
    flags: {
      plan: {
        value: "<PPP>",
        effect:
          "Show only that plan: {hub, last_activity, plan}, the same item --detail lists in plans[].",
      },
      spec: {
        value: "<NNN>",
        effect:
          "Show only that spec: {hub, last_activity, spec}, the same item --detail lists in specs[].",
      },
    },
    output:
      "Default: {hub, last_activity, pipeline[]?, notices[]? {kind, message, next}, counts}, empty collections left out. --detail: {hub, last_activity, specs[], plans[] (phases, tasks, plan_state, assurance, baseline, reconciliation), sessions {active[], closed[], paused[], abandoned[]}, history_remote_rows[], history_collisions[], discarded[], terminal_events[], pending_retirements[], pipeline[], counts, ...}. --plan or --spec: {hub, last_activity, plan|spec}. Read-only.",
    exit_codes: {
      "1": "STATUS_DOCUMENT_NOT_FOUND: no document has that number; STATUS_FILTER_CONFLICT: --plan and --spec together.",
    },
    notes: [
      "By default the human view and the JSON carry the same scope: pending work, notices and counts, so their size follows what is pending and not the hub's history. --detail, in either format, is the full inventory with finished history, sessions and discarded items.",
      "--plan and --spec compare the number by value (87 and 087 are the same plan); their size does not depend on the hub's history.",
    ],
  },

  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult<StatusCommandOutput>> {
    const plan = flagValue(args, "plan");
    const spec = flagValue(args, "spec");
    if (plan !== undefined && spec !== undefined) {
      return fail("STATUS_FILTER_CONFLICT", "--plan y --spec no se combinan: pedí un documento");
    }
    const data = await runStatusCommand(ctx.fs, ctx.env, ctx.paths, { git: ctx.git });
    if (plan !== undefined) return documentResult(data, "plan", plan);
    if (spec !== undefined) return documentResult(data, "spec", spec);
    return { ok: true, data, exitCode: 0 };
  },

  /**
   * The default JSON is the same scope as the default human view: what is
   * pending, the notices, and the counts. `--detail` is the whole model, and a
   * single document (`--plan`/`--spec`) is already narrow, so neither is touched.
   */
  projectJson(data: StatusCommandOutput, context: HumanRenderContext): unknown {
    if (context.detail || !("pipeline" in data)) return data;
    return compactStatus(data);
  },

  /**
   * The human view shows PENDING work only. Finished history, sessions and
   * discarded items are real and stay in the `--detail` model — they just stop
   * competing for attention with what is actually left to do. `--detail`
   * brings them back; the filter never removes anything from the domain.
   */
  renderHuman(result: CommandResult<StatusCommandOutput>, context: HumanRenderContext): string {
    const data = result.data;
    if (data === undefined) return "";
    if (!("pipeline" in data)) return renderDocument(data);
    return context.detail ? renderFull(data) : renderCompact(data);
  },
};

/** One thing on the board that is not pending work but must stay visible. */
export interface StatusNotice {
  kind: StatusNoticeKind;
  message: string;
  next: string;
}

type StatusNoticeKind =
  | "loose-sessions"
  | "sessions-set-aside"
  | "reservation"
  | "reservations-unreadable"
  | "history-remote"
  | "history-collision"
  | "source-unreadable"
  | "isolation-error"
  | "docs-canon"
  | "orphan-unit"
  | "pending-retirement"
  | "unverified-closure";

const NOTICE_TITLES: Record<StatusNoticeKind, string> = {
  "loose-sessions": "Sesiones con trabajo y sin documento",
  "sessions-set-aside": "Sesiones apartadas",
  reservation: "Correlativos reservados",
  "reservations-unreadable": "docs/ ilegible",
  "history-remote": "HISTORY: sesiones de otra máquina",
  "history-collision": "HISTORY: números compartidos",
  "source-unreadable": "Fuentes sin ruta",
  "isolation-error": "Unidades no verificables",
  "docs-canon": "Configuración [docs] inválida",
  "orphan-unit": "Unidades huérfanas",
  "pending-retirement": "Retiros a medias",
  "unverified-closure": "Planes cerrados sin verificación completa",
};

/** The default board: pending work, notices and counts; empty collections left out. */
function compactStatus(data: StatusOutput): Record<string, unknown> {
  const notices = statusNotices(data);
  return {
    hub: data.hub,
    last_activity: data.last_activity,
    ...(data.pipeline.length > 0 ? { pipeline: data.pipeline } : {}),
    ...(notices.length > 0 ? { notices } : {}),
    counts: data.counts,
  };
}

/** Every notice of the board, each with the one action that addresses it. */
export function statusNotices(data: StatusOutput): StatusNotice[] {
  return [...sessionNotices(data), ...hubNotices(data), ...workNotices(data)];
}

const notice = (kind: StatusNoticeKind, message: string, next: string): StatusNotice => ({
  kind,
  message,
  next,
});

function sessionNotices(data: StatusOutput): StatusNotice[] {
  const notices: StatusNotice[] = [];
  if (data.loose_sessions.length > 0) {
    notices.push(
      notice(
        "loose-sessions",
        `${data.loose_sessions.length} sesión(es) con trabajo y sin documento asociado`,
        "aw status --detail",
      ),
    );
  }
  if (data.counts.sessions_paused || data.counts.sessions_abandoned) {
    notices.push(
      notice(
        "sessions-set-aside",
        `${data.counts.sessions_paused} pausada(s), ${data.counts.sessions_abandoned} abandonada(s)`,
        "aw status --detail",
      ),
    );
  }
  return notices;
}

/** What is wrong with the hub itself: history, sources, isolation and configuration. */
function hubNotices(data: StatusOutput): StatusNotice[] {
  return [
    ...data.history_remote_rows.map((row) =>
      notice(
        "history-remote",
        `sin carpeta local: ${row}`,
        "ninguna: la sesión vive en otra máquina",
      ),
    ),
    ...data.history_collisions.map((collision) =>
      notice(
        "history-collision",
        `${collision.local} comparte número con ${collision.registered}`,
        collision.action,
      ),
    ),
    ...(data.unreadable_sources ?? []).map((source) =>
      notice("source-unreadable", `${source.alias}: ${source.error}`, "aw sources --verbose"),
    ),
    ...(data.isolation_error === undefined
      ? []
      : [notice("isolation-error", data.isolation_error, "aw worktree list")]),
    ...(data.docs_canon_error === undefined
      ? []
      : [
          notice(
            "docs-canon",
            data.docs_canon_error,
            "corregí la sección [docs] de la configuración",
          ),
        ]),
    ...(data.reservations_error === undefined
      ? []
      : [
          notice(
            "reservations-unreadable",
            data.reservations_error,
            "revisá los permisos de docs/",
          ),
        ]),
  ];
}

/** Work that is held, left behind or closed without full evidence. */
function workNotices(data: StatusOutput): StatusNotice[] {
  return [
    ...data.reservations.map((slot) =>
      notice(
        "reservation",
        `${slot.correlative} · ${slot.file} — ${reservationState(slot)}; no es un documento`,
        slot.next,
      ),
    ),
    ...data.orphan_units.map((unit) =>
      notice("orphan-unit", `${unit.alias} · ${unit.session} — ${unit.reason}`, unit.release),
    ),
    ...data.pending_retirements.map((retirement) =>
      notice(
        "pending-retirement",
        `${retirement.command} ${retirement.target} quedó a medias (${retirement.phase})`,
        retirement.next,
      ),
    ),
    ...data.plans
      .filter(
        (plan) =>
          plan.plan_state === "done" && plan.assurance !== null && plan.assurance !== "verified",
      )
      .map((plan) =>
        notice(
          "unverified-closure",
          `plan ${plan.number} — done · no verificado (${plan.assurance})`,
          `aw status --plan ${plan.number}`,
        ),
      ),
  ];
}

/** The default human board: the same scope as the default JSON. */
function renderCompact(data: StatusOutput): string {
  const header = `${data.hub.name} · ${data.hub.path}`;
  const notices = statusNotices(data);
  if (data.pipeline.length === 0 && notices.length === 0) return `${header} — sin pendientes\n`;
  const lines = [header, ""];
  if (data.last_activity !== null) lines.push(`Última actividad: ${data.last_activity}`, "");
  lines.push(...renderPipeline(data.pipeline, false));
  for (const kind of Object.keys(NOTICE_TITLES) as StatusNoticeKind[]) {
    const group = notices.filter((notice) => notice.kind === kind);
    if (group.length === 0) continue;
    lines.push(`${NOTICE_TITLES[kind]} (${group.length})`);
    for (const notice of group) lines.push(`  ${notice.message}`, `    → ${notice.next}`);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/** The `--detail` board: everything the model holds, as it always rendered. */
function renderFull(data: StatusOutput): string {
  const header = `${data.hub.name} · ${data.hub.path}`;
  const lines = [header, ""];
  if (data.last_activity !== null) lines.push(`Última actividad: ${data.last_activity}`, "");
  lines.push(...renderPipeline(data.pipeline, true));
  lines.push(...renderLooseSessions(data, lines.at(-1)));
  if (data.counts.sessions_paused || data.counts.sessions_abandoned) {
    lines.push(
      `Sesiones apartadas: ${data.counts.sessions_paused} pausada(s), ${data.counts.sessions_abandoned} abandonada(s)`,
      "",
    );
  }
  appendHubAlerts(lines, data);
  // A held correlative is not pending work — nobody should weigh it against an
  // open plan — but it must be VISIBLE. Leaving it out of the human view took
  // the board from wrong (it used to offer `/w:plan-exec` on a bare marker) to
  // silent, and the one case that actually needs a person to decide — an
  // ownerless legacy placeholder — had no trace outside `aw claims`.
  lines.push(...renderReservations(data, lines.at(-1)));
  lines.push(...renderAssuranceAlerts(data, lines.at(-1)));
  lines.push("", ...renderDetail(data));
  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * The board narrowed to one document, picked out of the model the service already
 * built: the record is the `--detail` item by construction, and a number nobody
 * holds is an error that names it — an empty answer would read as "nothing owed".
 */
function documentResult(
  data: StatusOutput,
  kind: "plan" | "spec",
  wanted: string,
): CommandResult<StatusCommandOutput> {
  const sameNumber = (number: string) => /^\d+$/.test(wanted) && Number(number) === Number(wanted);
  const header = { hub: data.hub, last_activity: data.last_activity };
  if (kind === "plan") {
    const plan = data.plans.find((item) => sameNumber(item.number));
    if (plan !== undefined) return { ok: true, data: { ...header, plan }, exitCode: 0 };
  } else {
    const spec = data.specs.find((item) => sameNumber(item.number));
    if (spec !== undefined) return { ok: true, data: { ...header, spec }, exitCode: 0 };
  }
  return fail(
    "STATUS_DOCUMENT_NOT_FOUND",
    `no hay ${kind === "plan" ? "plan" : "spec"} con número '${wanted}' en ${data.hub.name}`,
  );
}

/** One record over a few lines, in the same words the pipeline uses for it. */
function renderDocument(data: StatusDocumentOutput): string {
  const lines = [`${data.hub.name} · ${data.hub.path}`, ""];
  if ("plan" in data) {
    const { plan } = data;
    const { detail } = planPresentation(plan);
    lines.push(detail.objective, `  estado: ${plan.plan_state} · ${detail.progress}`);
    for (const phase of plan.blocked_phases) {
      lines.push(`  bloqueada F${phase.number} — ${phase.name}: ${phase.blocker ?? "sin motivo"}`);
    }
    lines.push(`  ${detail.next}`);
  } else {
    const { spec } = data;
    // Whether a ready spec already has its plan is a fact of the whole board, so
    // the single record states its own status and leaves that line out.
    const detail = specDetail(spec, []);
    lines.push(detail.objective, `  ${detail.progress}`);
    if (spec.status !== "ready-for-plan") lines.push(`  ${detail.next}`);
  }
  return `${lines.join("\n")}\n`;
}

const GROUP_TITLES: Record<PipelineItem["kind"], string> = {
  "spec-unrefined": "Specs sin refinar",
  "spec-unplanned": "Specs sin plan",
  "plan-open": "Planes abiertos",
  "plan-handoff": "Planes cerrados con traspaso vigente",
  "plan-pass": "Planes cerrados con pase pendiente",
  // Kept because the model keeps the class: a loose checkpoint is reported as a
  // notice now, so nothing reaches this row — and the day something does, it is
  // titled rather than rendered as a blank group.
  "checkpoint-orphan": "Checkpoints sueltos",
};

/** `plan` · `spec` · `sesión` — how an item names itself when its detail leads. */
const KIND_NOUNS: Record<PipelineItem["kind"], string> = {
  "spec-unrefined": "spec",
  "spec-unplanned": "spec",
  "plan-open": "plan",
  "plan-handoff": "traspaso",
  "plan-pass": "pase",
  "checkpoint-orphan": "sesión",
};

/**
 * Each pending item over three lines: what it is, what it still owes, and the
 * command that continues it.
 *
 * The middle line is the whole point — a board that listed only the title and the
 * command could say `plan 031 — 100%, fases 6/6` about a plan whose final
 * validation had never run. When what it owes is an OBLIGATION that leaves it
 * neither runnable nor closable, that obligation takes the headline and the
 * percentage drops below it: read in the other order, the number is the part
 * people believe.
 */
function renderPipeline(pipeline: PipelineItem[], detail: boolean): string[] {
  const lines: string[] = [];
  for (const kind of Object.keys(GROUP_TITLES) as Array<PipelineItem["kind"]>) {
    const items = pipeline.filter((item) => item.kind === kind);
    lines.push(...renderPipelineGroup(kind, items, detail));
  }
  return lines;
}

function renderPipelineGroup(
  kind: PipelineItem["kind"],
  items: PipelineItem[],
  detail: boolean,
): string[] {
  if (items.length === 0) return [];
  return [
    `${GROUP_TITLES[kind]} (${items.length})`,
    ...items.flatMap((item) => renderPipelineItem(item, detail)),
    "",
  ];
}

function renderPipelineItem(item: PipelineItem, detail: boolean): string[] {
  const { next, progress, obligation } = item.detail;
  const command =
    item.command === null
      ? `    Bloqueado · ${item.action.kind === "blocked" ? item.action.action : next}`
      : `    ${item.command}`;
  return [
    obligation ? `  ${KIND_NOUNS[item.kind]} ${item.number} — ${next}` : `  ${item.summary}`,
    `    ${obligation ? progress : next}`,
    command,
    // Always shown, not only under --detail: a row sitting below the ones a
    // person declared should go first has to say WHY it is down there, or the
    // board looks like it reordered itself. It is also why the command stays on
    // the line above — postponed is not blocked.
    ...(item.detail.postponed !== undefined
      ? [`    Postergado · ${item.detail.postponed.reason}`]
      : []),
    ...(detail && item.detail.warning !== undefined
      ? [`    Aviso · ${item.detail.warning.message}`]
      : []),
  ];
}

/**
 * Loose sessions, as a notice with its count and how to look.
 *
 * The folders stay out of the default view on purpose: what a person needs here
 * is to know the work exists and that nothing on this board accounts for it.
 * Retiring one is another job, and this read does not do it.
 */
/** What a held correlative IS, in the words a person needs to decide. */
function reservationState(slot: StatusOutput["reservations"][number]): string {
  if (slot.kind === "legacy-placeholder") return "placeholder legacy ambiguo, sin dueño";
  const notes = [
    slot.ownerActive === true ? "sesión activa" : null,
    slot.intact ? null : "marcador alterado",
    slot.revoked ? "revocada" : null,
  ].filter((note) => note !== null);
  return `reserva de ${slot.owner}${notes.length > 0 ? ` (${notes.join(", ")})` : ""}`;
}

/**
 * Correlatives held by a reservation or a legacy placeholder, with the one action
 * that resolves each.
 *
 * Never a pipeline group: a held number is not a document somebody can execute,
 * and presenting it as one is the defect this whole change exists to close. It is
 * a notice with its own line per slot, because the action differs by state — a
 * live owner finishes or closes its own reservation, and only a slot nobody is
 * finishing gets recovered.
 */
function renderReservations(data: StatusOutput, before: string | undefined): string[] {
  if (data.reservations.length === 0 && data.reservations_error === undefined) return [];
  const lines = before === "" ? [] : [""];
  if (data.reservations.length > 0) {
    lines.push(`Correlativos reservados (${data.reservations.length}) — no son documentos:`);
    for (const slot of data.reservations) {
      lines.push(
        `  ${slot.correlative} · ${slot.file} — ${reservationState(slot)}`,
        `    → ${slot.next}`,
      );
    }
  }
  // An unreadable docs/ is not an empty one, and the board has to say which.
  if (data.reservations_error !== undefined) {
    lines.push(`Aviso: ${data.reservations_error}`);
  }
  return lines;
}

function renderLooseSessions(data: StatusOutput, before: string | undefined): string[] {
  const count = data.loose_sessions.length;
  if (count === 0) return [];
  const lines = before === "" ? [] : [""];
  lines.push(
    `Aviso: ${count} sesión(es) con trabajo y sin documento asociado — vela con 'aw status --detail'`,
  );
  return lines;
}

/** A closed plan is not pending, but accepted missing evidence must stay visible. */
function renderAssuranceAlerts(data: StatusOutput, before: string | undefined): string[] {
  const accepted = data.plans.filter(
    (plan) =>
      plan.plan_state === "done" && plan.assurance !== null && plan.assurance !== "verified",
  );
  if (accepted.length === 0) return [];
  const lines = before === "" ? [] : [""];
  lines.push(`Planes cerrados sin verificación completa (${accepted.length})`);
  for (const plan of accepted) {
    lines.push(`  plan ${plan.number} — done · no verificado (${plan.assurance})`);
  }
  return lines;
}

function renderDetail(data: StatusOutput): string[] {
  const done = data.plans.filter((p) => p.plan_state === "done");
  const lines = [
    `Terminado: ${done.length} plan(es) done de ${data.plans.length}`,
    `Sesiones: ${data.counts.sessions_active} activa(s), ${data.counts.sessions_paused} pausada(s), ${data.counts.sessions_abandoned} abandonada(s), ${data.counts.sessions_closed} cerrada(s)`,
  ];
  for (const spec of data.specs.filter((item) => item.status === "superseded")) {
    lines.push(`  · spec ${spec.number} — ${specDetail(spec, data.plans).next}`);
  }
  for (const plan of done.filter((p) => p.assurance !== null && p.assurance !== "verified")) {
    lines.push(`  · plan ${plan.number} — done · no verificado (${plan.assurance})`);
  }
  for (const session of data.sessions.active) {
    lines.push(`  · ${session.folder} — ${session.summary} (${session.relative})`);
    // A run stopped at a boundary is what that session is actually waiting on,
    // and at an execution boundary the invocation is printed verbatim: whoever
    // resumes must never have to reconstruct the command from prose.
    if (session.flow !== null) lines.push(`      ${session.flow.summary}`);
  }
  for (const session of data.sessions.paused) lines.push(`  · ${session.folder} — pausada`);
  for (const session of data.sessions.abandoned) lines.push(`  · ${session.folder} — abandonada`);
  if (data.discarded.length > 0) {
    lines.push(`Descartados: ${data.discarded.length}`);
    for (const item of data.discarded) {
      lines.push(`  · [${item.kind}] ${item.text} — ${item.source}`);
    }
  }
  // A standalone plan is not debt: it declared that it derives from the
  // conversation, so there is no spec whose proof is missing. Counting it here
  // asked somebody, release after release, to go prove a lineage that by
  // construction does not exist.
  const unproven = data.plans.filter(
    (p) => p.spec.status !== "resolved" && p.spec.status !== "standalone",
  );
  if (unproven.length > 0) {
    lines.push(`Planes sin spec demostrada: ${unproven.map((p) => p.number).join(", ")}`);
  }
  return lines;
}

function appendHubAlerts(lines: string[], data: StatusOutput): void {
  if (data.history_remote_rows.length > 0 || data.history_collisions.length > 0) {
    lines.push("HISTORY: sesiones de otra máquina o números compartidos");
    for (const row of data.history_remote_rows) lines.push(`  sin carpeta local: ${row}`);
    for (const collision of data.history_collisions) {
      lines.push(
        `  ${collision.local} comparte número con ${collision.registered} → ${collision.action}`,
      );
    }
    lines.push("");
  }
  if (data.unreadable_sources?.length || data.isolation_error) {
    lines.push("Fuentes sin ruta o unidades no verificables");
    for (const source of data.unreadable_sources ?? []) {
      lines.push(`  ${source.alias}: ${source.error}`);
    }
    if (data.isolation_error) lines.push(`  ${data.isolation_error}`);
    lines.push("");
  }
}
