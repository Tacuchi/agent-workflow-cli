// [Workline] tab data — hardcoded to avoid I/O during render.
// Kept in sync with the redesigned model (stages + loops + artifacts):
//   - skills/w/commands/   (/w: slash commands — 1 per .md file)
//   - skills/w/README.md   (3 flows: SPEC / PLAN / QUICK)
//   - skills/w/hooks/hooks.template.json (5 events)
//
// Drift points: if /w: commands are added/removed in `commands/` or hooks in
// the template, update this file. Totals are derived with `.length` at
// runtime — do NOT hardcode counts in strings.

// Shapes owned by the data module, reduced to what the TUI consumes (the
// flows strip uses id+title; counts use .length of slashCommands/hooks).
export interface WorkflowPhase {
  id: string;
  title: string;
}

export interface HookEntry {
  name: string;
  matcher: string;
  fires: string;
}

export interface WorkflowContent {
  overview: string;
  phases: WorkflowPhase[];
  slashCommands: string[];
  hooks: HookEntry[];
}

export const WORKFLOW_CONTENT: WorkflowContent = {
  // Single line: [Workline] renders it with truncate — the doctrinal detail
  // lives in the `w` bundle, not in the TUI.
  overview:
    "3 flows (SPEC · PLAN · QUICK) drive convergent loops — each a persistent goal that runs until its Success criteria are green (verification-first).",

  // The model's 3 FLOWS + bootstrap (workspace-init) + export-* family.
  phases: [
    { id: "workspace-init", title: "Workspace init" },
    { id: "spec", title: "SPEC — the what" },
    { id: "plan", title: "PLAN — the how" },
    { id: "quick", title: "QUICK — the shortcut" },
    { id: "export", title: "Export — promote to docs/" },
  ],

  // /w: slash commands — `ls skills/w/commands/*.md` (excl. README).
  slashCommands: [
    "/w:workspace-init",
    "/w:spec-new",
    "/w:spec-refine",
    "/w:plan-new",
    "/w:plan-refine",
    "/w:plan-exec",
    "/w:quick",
    "/w:status",
    "/w:fix-git",
    "/w:generate-launch",
    "/w:persist",
    "/w:resume",
    "/w:export-scripts",
    "/w:export-manuals",
    "/w:export-diagrams",
    "/w:export-reports",
  ],

  // The 5 hooks of hooks.template.json — real matcher + what they fire.
  hooks: [
    {
      name: "SessionStart",
      matcher: "startup|resume|clear",
      fires: "Inject namespace into ~/.config/agent-workflow/namespace",
    },
    {
      name: "PreToolUse",
      matcher: "Edit|Write|MultiEdit · mcp__*__execute_sql · Bash",
      fires: "branch-check · sql-mutation-guard · git-commit-advisor",
    },
    {
      name: "SessionEnd",
      matcher: "(any)",
      fires: "agent-workflow auto-compact-on-close",
    },
    {
      name: "PreCompact",
      matcher: "(any)",
      fires: "checkpoint-write — writes CHECKPOINT.md before compacting",
    },
    {
      name: "PostCompact",
      matcher: "(any)",
      fires: "resume-summary + prompt to reload CHECKPOINT.md",
    },
  ],
};
