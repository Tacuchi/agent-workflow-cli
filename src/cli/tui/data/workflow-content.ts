// Datos del [Workflows] tab — hardcoded para evitar I/O en render.
// Sincronizado con el modelo rediseñado (stages + loops + artifacts):
//   - skills/w/commands/   (/w: slash commands — 1 por archivo .md)
//   - skills/w/README.md   (3 flows: SPEC / PLAN / QUICK)
//   - skills/w/hooks/hooks.template.json (5 eventos)
//
// Puntos de drift: si se agregan/quitan /w: commands en `commands/` o hooks en
// el template, actualizar este archivo. Los totales se derivan con `.length` en
// runtime — NO hardcodear cantidades en strings.

// Shapes propios del data module, reducidos a lo que la TUI consume: el strip
// de flows usa id+title; commandFamilies solo alimenta el count transitorio de
// sub-skills en [Skills] (desaparece con su reescritura como manager de sueltas).
export interface WorkflowPhase {
  id: string;
  title: string;
}

export interface CommandFamily {
  id: string;
  items: string[];
}

export interface HookEntry {
  name: string;
  matcher: string;
  fires: string;
}

export interface WorkflowContent {
  overview: string;
  phases: WorkflowPhase[];
  commandFamilies: CommandFamily[];
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

  // Familias del CLI real (help-groups.ts post-cleanup) — hoy solo se consume
  // items.length para el count de sub-skills del [Skills] transitorio.
  commandFamilies: [
    {
      id: "session",
      items: ["sessions", "session-create", "session-resume", "session-close", "session-artifacts"],
    },
    {
      id: "checkpoint",
      items: ["checkpoint-read", "checkpoint-write", "auto-compact-on-close"],
    },
    {
      id: "sources",
      items: [
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
      id: "orchestration",
      items: ["status", "stack", "skill-index", "skills", "resume-summary", "next-number"],
    },
    {
      id: "doctor",
      items: [
        "plugin-doctor",
        "plugin-cache",
        "host-doctor",
        "history-update",
        "release-data",
        "code-scan",
        "project-md-upsert",
        "bootstrap-dsn",
      ],
    },
    {
      id: "hooks",
      items: ["hook branch-check", "hook sql-mutation-guard", "hook git-commit-advisor"],
    },
    {
      id: "mcp",
      items: ["mcp dbhub", "mcp setup", "mcp remove", "mcp doctor", "mcp warp-status"],
    },
    {
      id: "dev",
      items: ["harness", "profiles", "logs"],
    },
    {
      id: "self",
      items: [
        "self doctor",
        "self install",
        "self uninstall",
        "self detect-hosts",
        "self mcp",
        "self bootstrap",
      ],
    },
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
