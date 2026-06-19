// Help grouping for `aw --help` (Propuesta 002 G4 H-06). Commands are organized by
// family so users can scan by intent (session lifecycle, checkpoint workflow,
// orchestration helpers, etc.) instead of one long alphabetical list.
//
// Adding a new command? Decide which family it belongs to and append it to
// the matching group below. Commands not listed in any group fall through to
// the "Other" section automatically.

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
    name: "Objetivo / Tasks",
    commands: ["objetivo-data", "tasks-data", "decisiones-list", "dependencias-list"],
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
    commands: ["sources", "attach-multiroot", "detach-multiroot", "check-branch"],
  },
  {
    name: "Orchestration",
    commands: [
      "workspace-mode",
      "stack",
      "skill-index",
      "resume-summary",
    ],
  },
  {
    name: "Doctor / Data",
    commands: [
      "plugin-doctor",
      "plugin-cache",
      "history-data",
      "history-update",
      "release-data",
      "code-scan",
      "project-md-upsert",
      "bootstrap-dsn",
      "upgrade-hub-mode",
    ],
  },
  { name: "Hooks", commands: ["hook"] },
  { name: "MCP", commands: ["mcp"] },
  { name: "Dev-only", commands: ["harness", "profiles", "logs", "next-number"] },
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

export function renderGroupedCommandLines(allCommands: string[]): string[] {
  const groups = groupCommands(allCommands);
  const lines: string[] = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (!g) continue;
    lines.push(`${g.name}:`);
    for (const c of g.commands) lines.push(`  ${c}`);
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
