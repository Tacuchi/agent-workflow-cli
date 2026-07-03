// Datos del [Workflows] tab — hardcoded para evitar I/O en render.
// Sincronizado con el modelo rediseñado (stages + loops + artifacts):
//   - skills/w/commands/   (/w: slash commands — 1 por archivo .md)
//   - skills/w/README.md   (3 flows: SPEC / PLAN / QUICK)
//   - skills/w/hooks/hooks.template.json (5 eventos)
//
// Puntos de drift: si se agregan/quitan /w: commands en `commands/` o hooks en
// el template, actualizar este archivo. Los totales se derivan con `.length` en
// runtime — NO hardcodear cantidades en strings.

// Shapes propios del data module, reducidos a lo que la TUI consume (el strip
// de flows usa id+title; los counts usan .length de slashCommands/hooks).
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
  // Una sola línea: [Workflows] la renderiza con truncate — el detalle doctrinal
  // vive en el bundle `w`, no en la TUI.
  overview:
    "3 flows (SPEC · PLAN · QUICK) drive convergent loops — each a persistent goal that runs until its Success criteria are green (verification-first).",

  // Las 3 FLOWS del modelo + bootstrap (workspace-init) + familia export-*.
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
    "/w:export-scripts",
    "/w:export-manuals",
    "/w:export-diagrams",
    "/w:export-reports",
  ],

  // 5 hooks de hooks.template.json — matcher real + qué disparan.
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
