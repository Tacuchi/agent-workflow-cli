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
    commands: [
      "checkpoint-read",
      "checkpoint-write",
      "compress-checkpoint",
      "auto-compact-on-close",
    ],
  },
  {
    name: "Sources / Branches",
    commands: [
      "workspace-init",
      "sources",
      "set-working-branch",
      "set-qa-branch",
      "remove-source",
      "git-flow",
      "merge-state",
      "attach-multiroot",
      "detach-multiroot",
      "visibility",
      "check-branch",
    ],
  },
  {
    name: "Orchestration",
    // next-number is a core helper (the bundle skills call it for NNN
    // correlatives), not dev-only; skills/skill-index resolve capability bindings.
    commands: ["status", "stack", "skill-index", "skills", "resume-summary", "next-number"],
  },
  {
    name: "Doctor / Data",
    commands: [
      "plugin-doctor",
      "plugin-cache",
      "host-doctor",
      "history-data",
      "history-update",
      "release-data",
      "code-scan",
      "project-md-upsert",
      "bootstrap-dsn",
    ],
  },
  { name: "Hooks", commands: ["hook"] },
  { name: "MCP", commands: ["mcp"] },
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
 * Help body for `<command> --help`: the command name + its `describe`. Kept here
 * (pure, tested) so `main.ts` only does the I/O. The `describe` already carries the
 * flag summary, so this is the per-subcommand help — not the global command list.
 */
export function commandHelpText(command: { name: string; describe?: string }): string {
  return [`agent-workflow ${command.name}`, "", command.describe ?? "(sin descripción)", ""].join(
    "\n",
  );
}
