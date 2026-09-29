import type { FlagContract } from "./commands/unknown-flags.js";
import type { CliCommand, FlagHelp, HelpContract } from "./registry.js";

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
      "session-pause",
      "session-artifacts",
      "workspace-commit",
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
      "set-working-branch",
      "set-qa-branch",
      "set-exception-branch",
      "set-edit-mode",
      "set-pipeline",
      "remove-source",
      "add-source",
      "git-flow",
      "merge-state",
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
    // correlatives), not dev-only; skills diagnoses owned capabilities.
    commands: [
      "status",
      "resume",
      // What the other hosts of the machine learned about Workline, read-only:
      // the substrate `/w:recall` judges, as `status` is for `/w:status`.
      "host-memory",
      "persist",
      "stack",
      "skills",
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
      "host-doctor",
      "history",
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

/** What a help renderer reads of a command: its name, contracts and projections. */
export type HelpSubject = Pick<CliCommand, "name" | "help" | "flags" | "hook"> &
  Partial<Pick<CliCommand, "renderHuman" | "renderRawJson">>;

interface HelpScope {
  contract: FlagContract;
  help: Readonly<Record<string, FlagHelp>>;
}

/** The flag scopes one invocation reads: the command's own, plus its action's. */
function scopesOf(command: HelpSubject, action?: string): HelpScope[] {
  const scopes: HelpScope[] = [{ contract: command.flags, help: command.help.flags ?? {} }];
  const own = action === undefined ? undefined : command.flags.actions?.[action];
  if (own !== undefined) {
    scopes.push({ contract: own, help: command.help.actions?.[action as string]?.flags ?? {} });
  }
  return scopes;
}

function flagToken(name: string, help: FlagHelp | undefined): string {
  return help?.value === undefined ? `--${name}` : `--${name} ${help.value}`;
}

/**
 * The usage line, generated from the flag contract: a required flag bare, an
 * exclusive group in parentheses, anything else in brackets. It names exactly
 * the flags the dispatcher accepts for that invocation.
 */
export function usageLine(command: HelpSubject, action?: string): string {
  const selected = action !== undefined && command.flags.actions?.[action] !== undefined;
  const head = [`aw ${command.name}`];
  if (selected) head.push(action as string);
  else if (command.flags.actions !== undefined) head.push("<action>");
  const args = selected ? command.help.actions?.[action as string]?.args : command.help.args;
  if (args !== undefined) head.push(args);
  const parts: string[] = [];
  for (const { contract, help } of scopesOf(command, selected ? action : undefined)) {
    const grouped = new Set((contract.exclusive ?? []).flat());
    for (const group of contract.exclusive ?? []) {
      parts.push(`(${group.map((name) => flagToken(name, help[name])).join(" | ")})`);
    }
    for (const name of contract.known) {
      if (grouped.has(name)) continue;
      const token = flagToken(name, help[name]);
      const repeat = contract.repeatable?.includes(name) ? "..." : "";
      parts.push(contract.required?.includes(name) ? `${token}${repeat}` : `[${token}]${repeat}`);
    }
  }
  return [...head, ...parts].join(" ");
}

function flagModifiers(contract: FlagContract, name: string): string {
  const modifiers = [
    contract.required?.includes(name) ? "required" : "",
    contract.exclusive?.some((group) => group.includes(name)) ? "exclusive" : "",
    contract.repeatable?.includes(name) ? "repeatable" : "",
  ].filter(Boolean);
  return modifiers.length === 0 ? "" : ` (${modifiers.join(", ")})`;
}

function flagLines(command: HelpSubject, action?: string): string[] {
  const rows: [string, string][] = [];
  const groups: string[] = [];
  for (const { contract, help } of scopesOf(command, action)) {
    for (const name of contract.known) {
      const entry = help[name];
      rows.push([flagToken(name, entry), `${entry?.effect ?? ""}${flagModifiers(contract, name)}`]);
    }
    for (const group of contract.exclusive ?? []) {
      groups.push(`  exactly one of: ${group.map((name) => `--${name}`).join(" | ")}`);
    }
  }
  if (rows.length === 0) return [];
  const width = Math.max(...rows.map(([token]) => token.length));
  return [
    "",
    "Flags:",
    ...rows.map(([token, effect]) => `  ${token.padEnd(width)}  ${effect}`),
    ...groups,
  ];
}

function outputLines(command: HelpSubject, contract: HelpContract): string[] {
  const lines: string[] = [""];
  if (contract.output !== undefined) lines.push(`Output (JSON data): ${contract.output}`);
  lines.push(
    command.renderRawJson !== undefined
      ? "Output format: this command keeps its own protocol instead of the common envelope."
      : command.renderHuman !== undefined
        ? "Human output: yes (--format human, the default in a terminal)."
        : "Human output: no; the output is JSON in every mode.",
  );
  for (const [code, meaning] of Object.entries(contract.exit_codes ?? {})) {
    lines.push(`Exit ${code}: ${meaning}`);
  }
  if (command.hook === true) {
    lines.push("Hook target: the host runs it; an unknown flag is reported on stderr and ignored.");
  }
  return lines;
}

/**
 * The help of `aw <command> [<action>] --help`, derived from the command's help
 * contract and from the same flag contract the dispatcher enforces.
 */
export function commandHelpText(command: HelpSubject, action?: string): string {
  const actions = command.help.actions ?? {};
  const selected =
    action !== undefined && command.flags.actions?.[action] !== undefined ? action : undefined;
  const contract = selected === undefined ? command.help : (actions[selected] ?? command.help);
  const lines = [
    `aw ${command.name}${selected === undefined ? "" : ` ${selected}`}`,
    "",
    contract.purpose,
    "",
    `Usage: ${usageLine(command, selected)}`,
  ];
  if (selected === undefined && Object.keys(actions).length > 0) {
    const width = Math.max(...Object.keys(actions).map((name) => name.length));
    lines.push("", "Actions (aw <command> <action> --help for each):");
    for (const [name, own] of Object.entries(actions)) {
      lines.push(`  ${name.padEnd(width)}  ${own.purpose}`);
    }
  }
  lines.push(...flagLines(command, selected), ...outputLines(command, contract));
  for (const note of contract.notes ?? []) lines.push("", note);
  return `${lines.join("\n")}\n`;
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
