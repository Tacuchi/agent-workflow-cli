// The run's scenario: one step per surface, the same for the six covered hosts.
//
// Every fixed answer is a LITERAL label the CLI emits. They were read from the
// 28.0.0 quick journey walked with `aw flow start --flow quick` + `aw flow submit`
// in a throwaway HOME and workspace (s280), and match `src/domain/flow/authority.ts`
// and `PAUSE_LABEL`/`STOP_LABEL` in `src/domain/flow/directive.ts`. The classifier
// never answers anything that is not one of these labels.

import { HOSTS } from "./hosts.mjs";

/** The flow controls every structured choice carries (CHASSIS: `flow` slot). */
export const FLOW_CONTROLS = ["Compactar", "Cerrar"];

/** The Workline MCP the run registers in each disposable home, and the only one an extract may name. */
export const PROBE_MCP = { name: "host-run-probe", dsnVar: "HOST_RUN_PROBE_DSN" };

/** Port 9 (discard) on loopback: nothing answers, so no query ever reaches a database. */
export const PROBE_DSN = "postgresql://127.0.0.1:9/host_run_probe?connect_timeout=2";

export const QUICK_OBJECTIVE =
  "Rediseñar la arquitectura completa del CLI en varias fuentes, con varios entregables y una migración de datos";

/** The trivial sub-task the size gate is trimmed to, fixed so no answer needs free text. */
export const QUICK_SUBTASK = "crear NOTES.md en la raíz del workspace con la línea 'host-run'";

const MUTATING_PROBE = "DELETE FROM host_run_probe WHERE id = 1";

/**
 * A boundary the step can reach: the labels it literally shows and the one the
 * run answers. `labels` are the alternatives WITHOUT the flow controls, which
 * every boundary adds; a screen must show all of them before anything is sent.
 */
function boundary(id, labels, answer) {
  if (!labels.includes(answer) && !FLOW_CONTROLS.includes(answer)) {
    throw new Error(`boundary ${id}: answer '${answer}' is not one of its labels`);
  }
  return { id, labels, answer };
}

/** The steps, host-neutral. `prompt(host)` renders the host's own invocation. */
export const STEPS = [
  {
    surface: "commands",
    command: "doctor",
    goal: "/w:doctor runs through the host's command packaging and relays the per-host degradations",
    prompt: (h) => h.command("doctor"),
    // The repair offer lists one option per finding (ids vary) plus the flow slot.
    boundaries: [boundary("doctor.repair-offer", [], "Cerrar")],
    stop: "the doctor report is relayed and its repair offer answered with Cerrar",
    evidence: ["doctor report on screen (Hosts · Veredicto)", "per-surface degradation lines"],
  },
  {
    surface: "structured-choice",
    command: "quick",
    goal: "a large objective reaches the size gate, answered Recortar alcance; the session stays active",
    prompt: (h) =>
      `${h.command("quick")} ${QUICK_OBJECTIVE}. Si recortás el alcance, la subtarea es: ${QUICK_SUBTASK}.`,
    boundaries: [
      boundary(
        "chassis.route-evaluation",
        ["Aceptar propuesta", "Pedir ajustes"],
        "Aceptar propuesta",
      ),
      boundary(
        "quick.gate-choice",
        ["Cambiar a SPEC", "Seguir en quick", "Recortar alcance"],
        "Recortar alcance",
      ),
      boundary(
        "quick.fix-preview-approval",
        ["Ejecutar tal cual", "Ajustar el enfoque", "Escalar a spec"],
        "Ejecutar tal cual",
      ),
    ],
    // quick.commit-authorization (Aprobar el commit · Dejar la tarea sin commitear) is
    // NOT answered here: the run stops before it so the compaction step finds the
    // session active.
    stop: "quick.commit-authorization (or any later boundary) shows: left unanswered, the session stays active",
    // Seeing one of these is the stop point itself. Its labels are the registry's
    // (src/domain/flow/authority.ts), so the stop is recognized, never answered.
    stopAt: [
      {
        id: "quick.commit-authorization",
        labels: ["Aprobar el commit", "Dejar la tarea sin commitear"],
      },
      {
        id: "chassis.commit-choice",
        labels: [
          "Cerrar sin commit",
          "Aprobar commit del workspace",
          "Copiar evidencia y cerrar",
          "Copiar evidencia y aprobar commit del workspace",
        ],
      },
    ],
    evidence: ["which boundary was answered", "native selector or labeled markdown", "mode"],
  },
  {
    surface: "mcp",
    command: null,
    goal: "the host lists the tools of the Workline MCP registered in its home; nothing is queried",
    prompt: () =>
      `List the tools the MCP server '${PROBE_MCP.name}' exposes, by name. Do not call any of them.`,
    boundaries: [],
    stop: "the tool list is on screen",
    evidence: ["execute_sql and search_objects named", "load receipt under <home>/.workflow/dev/"],
  },
  {
    surface: "hooks",
    command: null,
    goal: "SessionStart and the PreToolUse SQL guard leave their lines in the home's log",
    prompt: () =>
      `Call the execute_sql tool of the MCP server '${PROBE_MCP.name}' once with exactly this statement: ${MUTATING_PROBE}. Report the result and do not retry.`,
    // A permission prompt for the MCP call is the person's, never the run's.
    boundaries: [],
    stop: "the call returns (refused by the guard or by the unreachable server)",
    // The `hook sql-mutation-guard` line tells the guard's refusal apart from the
    // server's own; Pre/PostCompact lines are read after the compaction step.
    evidence: [
      "log: self namespace (SessionStart)",
      "log: hook sql-mutation-guard (PreToolUse)",
      "log: checkpoint-write / resume-summary (Pre/PostCompact)",
      "shim log: which binary ran each hook",
    ],
    judgedAfter: "compaction",
    // Pre/PostCompact only fire in the compaction step.
    requires: ["compaction"],
  },
  {
    surface: "host-memory",
    command: "recall",
    goal: "/w:recall reads host memories and its save offer is declined",
    prompt: (h) => h.command("recall"),
    // recall's save offer is authored by the agent, so its labels are not the CLI's;
    // the only literal ones are the flow controls, and Cerrar declines saving.
    boundaries: [boundary("recall.save-offer", [], "Cerrar")],
    stop: "every host row is reported and the save offer declined",
    evidence: ["state and reason of each host row"],
  },
  {
    surface: "compaction",
    command: "compact",
    goal: "compacting with the quick session active, then closing it with Cerrar",
    prompt: (h) => h.compact ?? h.command("resume"),
    // It compacts, and then closes, the quick session structured-choice leaves active.
    requires: ["structured-choice"],
    boundaries: [boundary("flow.close", [], "Cerrar")],
    stop: "the next boundary after compaction is answered Cerrar and the quick session closes",
    evidence: ["log: checkpoint-write / resume-summary", "CHECKPOINT.md of the quick session"],
  },
];

/** The step as a given host runs it: its literal invocation and how it is typed. */
export function stepForHost(step, hostId) {
  const host = HOSTS[hostId];
  if (host === undefined) throw new Error(`host '${hostId}' is not covered by the run`);
  const text = step.prompt(host);
  // A native /compact is typed; a Workline command (the resume fallback included)
  // goes through crush's palette.
  const isWorklineCommand =
    step.command !== null && !(step.surface === "compaction" && host.compact !== null);
  const viaPalette = host.palette === true && isWorklineCommand;
  return {
    surface: step.surface,
    host: hostId,
    invocation: { text, via: viaPalette ? "palette" : "prompt" },
    fallback: step.surface === "compaction" && host.compact === null,
    boundaries: step.boundaries,
    stopAt: step.stopAt ?? [],
    stop: step.stop,
    evidence: step.evidence,
  };
}

/**
 * The steps a `--steps` selection really needs, in scenario order: every
 * prerequisite is added, and reported so the person sees why. Unknown surfaces
 * are refused.
 */
export function resolveSteps(requested) {
  const unknown = requested.filter((s) => !STEPS.some((step) => step.surface === s));
  if (unknown.length > 0) throw new Error(`--steps: unknown surface ${unknown.join(", ")}`);
  const wanted = new Set(requested);
  let grew = true;
  while (grew) {
    grew = false;
    for (const step of STEPS) {
      if (!wanted.has(step.surface)) continue;
      for (const dep of step.requires ?? []) {
        if (!wanted.has(dep)) {
          wanted.add(dep);
          grew = true;
        }
      }
    }
  }
  const steps = STEPS.filter((s) => wanted.has(s.surface));
  const added = steps.map((s) => s.surface).filter((s) => !requested.includes(s));
  return { steps, added };
}

/** The whole scenario as data: what the digest seals and `--dry-run` prints. */
export function buildScenario(hostIds, steps = STEPS) {
  return {
    objective: QUICK_OBJECTIVE,
    subtask: QUICK_SUBTASK,
    probe_mcp: PROBE_MCP.name,
    flow_controls: FLOW_CONTROLS,
    steps: steps.map((step) => ({
      surface: step.surface,
      goal: step.goal,
      boundaries: step.boundaries,
      ...(step.stopAt ? { stop_at: step.stopAt.map((b) => b.id) } : {}),
      stop: step.stop,
      evidence: step.evidence,
      ...(step.judgedAfter ? { judged_after: step.judgedAfter } : {}),
      hosts: Object.fromEntries(hostIds.map((id) => [id, stepForHost(step, id).invocation])),
    })),
  };
}

/** Every label the scenario may send, for the executor's last check. */
export function scenarioAnswers() {
  return new Set(STEPS.flatMap((s) => s.boundaries.map((b) => b.answer)));
}
