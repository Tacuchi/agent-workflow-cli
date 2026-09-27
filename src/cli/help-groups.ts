import type { FlagContract } from "./commands/unknown-flags.js";
import type { CommandFlags } from "./registry.js";

// Help grouping for `aw --help` (Propuesta 002 G4 H-06). Commands are organized by
// family so users can scan by intent (session lifecycle, checkpoint workflow,
// orchestration helpers, etc.) instead of one long alphabetical list.
//
// Adding a new command? Decide which family it belongs to and append it to the
// matching group below. Any registered command NOT listed here falls into the
// catch-all "Other" section — the `help-groups` guard test fails if that happens,
// so every command must have a real home. Keep this in sync with
// `src/cli/tui/data/workflow-content.ts` (the TUI Workflow tab) too.

export interface CommandGroup {
  name: string;
  commands: string[];
}

const GROUPS: readonly CommandGroup[] = [
  {
    name: "Session lifecycle",
    commands: [
      "sessions",
      "session-create",
      "session-resume",
      "session-close",
      "session-artifacts",
    ],
  },
  {
    name: "Checkpoint",
    commands: ["checkpoint-read", "checkpoint-write", "auto-compact-on-close"],
  },
  {
    name: "Sources / Branches",
    commands: [
      "workspace-init",
      "workspace-move",
      "sources",
      "doc-branch",
      "generate-launch",
      "set-working-branch",
      "set-qa-branch",
      "set-exception-branch",
      "set-edit-mode",
      "set-pipeline",
      "remove-source",
      "add-source",
      "git-flow",
      "merge-state",
      "fix-git",
      "attach-multiroot",
      "detach-multiroot",
      "visibility",
      "check-branch",
      // The isolation unit of a flow: a worktree per (source, session) so two
      // flows never share a working tree.
      "worktree",
    ],
  },
  {
    name: "Orchestration",
    // next-number is a core helper (the bundle skills call it for NNN
    // correlatives), not dev-only; skills/skill-index resolve capability bindings.
    commands: [
      "status",
      "resume",
      // What the other hosts of the machine learned about Workline, read-only:
      // the substrate `/w:recall` judges, as `status` is for `/w:status`.
      "host-memory",
      "persist",
      "stack",
      "skill-index",
      "skills",
      // The durable design taxonomy: which UI Design Packages exist and where
      // they live right now (identity resolves, the path is only a hint).
      "designs",
      // The shared entry into a conformant capability: both routes — the direct
      // wrapper and a composing flow — reach the handlers through here.
      "capability",
      // The deterministic direction engine: advances a journey to its first
      // non-deterministic boundary and hands back that boundary's directive.
      "flow",
      "resume-summary",
      "next-number",
      // The reservations of numbered documents nobody is finishing, and the one
      // authorized way to give a correlative back: it revokes the claim durably
      // before releasing it, so a late sealed publication is rejected rather
      // than colliding on a number somebody else now holds.
      "claims",
      // The order and grouping a person meant for a cut of plans, declared once
      // and corrected by declaring again. It sits beside the board it reorders
      // because it is the only input the board's recommendation takes from a
      // human, and it constrains nothing: deviating is warned about, never
      // refused.
      "cut-intent",
      // The other half of the same reading: which passes to production exist,
      // which sources have actually arrived on each, and therefore what is
      // live. Closed is not released, and this is where the difference is
      // declared.
      "release-pass",
      // Context budget & read-set resolution (spec 009): what a command costs
      // to load, and which documents it actually has to load.
      "context-budget",
      "context-plan",
      // Retirement: `discard` takes a node and everything it exclusively owns;
      // `reset` puts an incomplete session's inputs back. Both all-or-nothing.
      "discard",
      "reset",
      // Documentary maintenance of the same graph those two retire from: it
      // rewrites the `> Baseline:` line of a plan whose review concluded it
      // still holds, so a legitimate divergence stops costing a whole
      // plan-refine. Lives here and not with the doctors because what it
      // maintains is the spec→plan lineage, not the tool's own records.
      "reseal",
      // The same lineage, one notch smaller: `reseal` rewrites the baseline of a
      // plan a review found still valid; `amend` corrects the WORDING of a
      // closed spec or plan without opening a refinement, refusing structurally
      // whatever touches the contract.
      "amend",
      // And the same lineage seen from its obligations: `settle` discharges or
      // acknowledges what a decision note left owing on a plan whose execution
      // run is long closed. It belongs beside these two and not with the doctors
      // for the same reason they do — what it maintains is the spec→plan
      // lineage, not the tool's own records — and it refuses outright while a
      // run holds the plan, because that run's own closure settles them.
      "settle",
      // Before any of them: `plan lint` reads a plan the way publication and the
      // execution entry read it, and lists every grammar violation at once.
      "plan",
    ],
  },
  {
    name: "Exports",
    // Each writes into exactly one docs/ folder and nowhere else.
    commands: ["export-diagrams", "export-manuals", "export-reports", "export-scripts"],
  },
  {
    name: "Doctor / Data",
    commands: [
      // The aggregate. It composes the specialized doctors below rather than
      // replacing them: each keeps its own contract and its own place here.
      "doctor",
      "plugin-doctor",
      "plugin-cache",
      "host-doctor",
      "history-update",
      "release-data",
      "code-scan",
      "project-md-upsert",
      // Lives with the record-repair family and not with `workspace-init`: it
      // does not create a workspace, it repairs the durable state of one that a
      // previous namespace left unreadable.
      "workspace-migrate",
    ],
  },
  { name: "Hooks", commands: ["hook"] },
  { name: "MCP", commands: ["mcp", "tool"] },
  { name: "Dev-only", commands: ["harness", "profiles", "logs"] },
  { name: "Self", commands: ["self"] },
];

export function groupCommands(allCommands: string[]): CommandGroup[] {
  const allSet = new Set(allCommands);
  const seen = new Set<string>();
  const out: CommandGroup[] = [];
  for (const group of GROUPS) {
    const present = group.commands.filter((c) => allSet.has(c));
    if (present.length === 0) continue;
    for (const c of present) seen.add(c);
    out.push({ name: group.name, commands: present });
  }
  const other = allCommands.filter((c) => !seen.has(c));
  if (other.length > 0) out.push({ name: "Other", commands: other });
  return out;
}

// Max width of the one-line summary in the global command list; longer first
// sentences are elided with an ellipsis so the help never wraps awkwardly.
const MAX_SUMMARY_WIDTH = 72;

/**
 * One-line gloss for the global command list: the first sentence of a command's
 * `describe`, minus any appended `Usage: …` clause (that belongs to
 * `<cmd> --help`). Elided to {@link MAX_SUMMARY_WIDTH}.
 */
export function commandSummary(describe: string): string {
  const head = describe.split(/\s+Usage:/i)[0]?.trim() ?? describe.trim();
  // First sentence = up to a `.`/`!`/`?` that is followed by whitespace + an
  // uppercase letter (a real sentence boundary). This skips ellipses ("...")
  // and abbreviations that are not followed by a capitalized word.
  const match = head.match(/^[\s\S]*?[.!?](?=\s+[A-ZÁÉÍÓÚÑ])/);
  let sentence = (match ? match[0] : head).trim();
  if (sentence.length > MAX_SUMMARY_WIDTH) {
    sentence = `${sentence.slice(0, MAX_SUMMARY_WIDTH - 1).trimEnd()}…`;
  }
  return sentence;
}

/**
 * Renders the grouped command list for `aw --help`. When `describes` is provided
 * (a name→describe map), each line becomes `name — <first sentence>` with the
 * names column-aligned; without it, names are listed alone (back-compat).
 */
export function renderGroupedCommandLines(
  allCommands: string[],
  describes?: ReadonlyMap<string, string>,
): string[] {
  const groups = groupCommands(allCommands);
  const nameWidth = describes ? Math.max(0, ...allCommands.map((c) => c.length)) : 0;
  const lines: string[] = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (!g) continue;
    lines.push(`${g.name}:`);
    for (const c of g.commands) {
      const describe = describes?.get(c);
      const summary = describe ? commandSummary(describe) : "";
      lines.push(summary ? `  ${c.padEnd(nameWidth)}  ${summary}` : `  ${c}`);
    }
    if (i < groups.length - 1) lines.push("");
  }
  return lines;
}

/**
 * The same flag contract used by the dispatcher drives command and action help.
 * The declared usage is authoritative; historical Usage clauses in `describe`
 * may advertise flags belonging to another action or retired flags.
 */
export function commandHelpText(
  command: { name: string; describe?: string; flags?: CommandFlags },
  action?: string,
): string {
  const actions = command.flags?.actions;
  const selected = action !== undefined && actions?.[action] !== undefined ? action : undefined;
  const description = command.describe ?? "(sin descripción)";
  const usageAt = description.indexOf("Usage:");
  const firstLine = usageAt < 0 ? description : description.slice(0, usageAt).trimEnd();
  const remainder =
    usageAt < 0 ? "" : description.slice(usageAt).split("\n").slice(1).join("\n").trim();
  const lines = [`agent-workflow ${command.name}${selected ? ` ${selected}` : ""}`, "", firstLine];
  if (command.flags?.usage) {
    lines.push("", `Usage: ${command.flags.usage.replace(/^Usage:\s*/, "")}`);
  } else if (usageAt >= 0) {
    lines.push("", description.slice(usageAt).split("\n")[0] ?? "");
  }
  if (actions && selected === undefined) {
    lines.push("", `Subverbos: ${Object.keys(actions).join(", ")}`);
  }
  if (command.flags) lines.push(...renderFlagLines(command.flags, selected));
  if (remainder) lines.push("", remainder);
  return `${lines.join("\n")}\n`;
}

function helpScopes(
  flags: CommandFlags,
  selected?: string,
): { contract: FlagContract; label: string }[] {
  const scopes = [{ contract: flags as FlagContract, label: "común" }];
  for (const [name, contract] of Object.entries(flags.actions ?? {})) {
    if (selected === undefined || selected === name) scopes.push({ contract, label: name });
  }
  return scopes;
}

function flagLabel(contract: FlagContract, flag: string, scope: string): string {
  const modifiers = [
    contract.required?.includes(flag) ? "obligatorio" : "",
    contract.exclusive?.some((group) => group.includes(flag)) ? "excluyente" : "",
    contract.repeatable?.includes(flag) ? "repetible" : "",
  ].filter(Boolean);
  return [scope, ...modifiers].join(", ");
}

function renderFlagLines(flags: CommandFlags, selected?: string): string[] {
  const scopes = helpScopes(flags, selected);
  const byName = new Map<string, string[]>();
  const lines: string[] = [];
  for (const { contract, label } of scopes) {
    for (const flag of contract.known) {
      byName.set(flag, [...(byName.get(flag) ?? []), flagLabel(contract, flag, label)]);
    }
  }
  if (byName.size === 0) return [];
  lines.push("", "Flags:");
  for (const [flag, labels] of byName) lines.push(`  --${flag} (${labels.join("; ")})`);
  for (const { contract } of scopes) {
    for (const names of contract.exclusive ?? []) {
      lines.push(`  exactamente uno: ${names.map((name) => `--${name}`).join(" | ")}`);
    }
  }
  return lines;
}

/**
 * The global `aw --help` body, pure so the output flags it documents can be
 * tested. `main.ts` only writes it.
 */
export function globalHelpText(
  commands: string[],
  describes: ReadonlyMap<string, string>,
  defaultNamespace: string,
): string {
  const lines = [
    "agent-workflow — Workline runtime CLI (session lifecycle)",
    "",
    "Usage:",
    "  agent-workflow [--namespace <name>]",
    "                 [--workspace <path>]",
    "                 [--plugin-root <path>] [--plugin-version <semver>] [--compat <range>]",
    "                 <command> [args...]",
    "",
    "Namespace resolution order: --namespace flag > AW_NAMESPACE env > nearest",
    "ancestor marker (.<ns>/sessions/) > ~/.config/agent-workflow/namespace >",
    `default '${defaultNamespace}'. --workspace selects an explicit workspace. Without`,
    "a marker, a directory outside a git checkout is an implicit root; inside",
    "an unclaimed checkout, specify --workspace or initialize a workspace.",
    "",
    "Output (any command):",
    "  --format human|json  projection of the result; default human in a terminal, json in a pipe",
    "  --json               same as --format json",
    "  --detail             wider human projection (implies human)",
    "  --ascii              human output, help and hook notices in ASCII only; AW_ASCII=1 sets",
    "                       it for every invocation. Refused with an explicit --json/--format json",
    "",
    "Commands:",
    "",
    ...renderGroupedCommandLines(commands, describes),
    "",
    "Aliases:",
    "  aw                  short alias of `agent-workflow`",
    "",
  ];
  return `${lines.join("\n")}\n`;
}
