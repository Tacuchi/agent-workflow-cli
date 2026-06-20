// Datos del Workflow tab — hardcoded para evitar I/O en render.
// Sincronizado con el modelo rediseñado (stages + loops + artifacts):
//   - skills/w/commands/   (/w: slash commands — 1 por archivo .md)
//   - skills/w/README.md   (3 layers + 3 flows: SPEC / PLANIFICATION / QUICK)
//   - src/cli/help-groups.ts (familias del CLI real, post-cleanup)
//   - skills/w/hooks/hooks.template.json (5 eventos)
//
// Puntos de drift: si se agregan/quitan /w: commands en `commands/`, o se
// renombran familias en help-groups.ts, actualizar este archivo. Los totales se
// derivan con `.length` en runtime — NO hardcodear cantidades en strings.

import type { FamilyCardData } from "../components/family-card.js";
import type { PhaseCardData } from "../components/phase-card.js";

export interface HookEntry {
  name: string;
  matcher: string;
  fires: string;
}

export interface WorkflowContent {
  overview: string;
  phases: PhaseCardData[];
  commandFamilies: FamilyCardData[];
  slashCommands: string[];
  hooks: HookEntry[];
}

export const WORKFLOW_CONTENT: WorkflowContent = {
  overview:
    "Stages + loops + artifacts — 3 flows (SPEC · PLANIFICATION · QUICK) drive convergent loops over session artifacts; export-* promotes to docs/.",

  // Las 3 FLOWS del modelo + bootstrap (workspace-init) + familia export-*.
  // Reusa PhaseCardData genérico (id/n/title/desc/commands/slash/hook).
  phases: [
    {
      id: "workspace-init",
      n: 1,
      title: "Workspace init",
      desc: "Bootstrap a folder into a workspace — .workflow/ + docs/ taxonomy + WORKSPACE block. Single-pass.",
      commands: ["workspace-init"],
      slash: "/w:workspace-init",
      hook: "SessionStart",
    },
    {
      id: "spec",
      n: 2,
      title: "SPEC — the what",
      desc: "Define the spec. spec-new is single-pass; spec-refine drives the refine loop → docs/specs.",
      commands: ["spec-new", "spec-refine"],
      slash: "/w:spec-new · /w:spec-refine",
      hook: "—",
    },
    {
      id: "planification",
      n: 3,
      title: "PLANIFICATION — the how",
      desc: "Plan and execute. plan-new + plan-exec each drive loops → docs/plans · docs/tools.",
      commands: ["plan-new", "plan-exec"],
      slash: "/w:plan-new · /w:plan-exec",
      hook: "PreCompact · PostCompact",
    },
    {
      id: "quick",
      n: 4,
      title: "QUICK — the shortcut",
      desc: "Lightweight one-command loop for small tasks. Owns no docs/ folder.",
      commands: ["quick"],
      slash: "/w:quick",
      hook: "SessionEnd",
    },
    {
      id: "export",
      n: 5,
      title: "Export — promote to docs/",
      desc: "The only artifact→docs/ promotion path. Read-only consolidation of session artifacts.",
      commands: ["export-scripts", "export-manuals", "export-diagrams", "export-reports"],
      slash: "/w:export-scripts …",
      hook: "—",
    },
  ],

  // Command families — espejo EXACTO de help-groups.ts (post-cleanup), con
  // los nombres de comandos realmente registrados en main.ts. `workspace-init`
  // y `set-working-branch` viven bajo Sources / Branches.
  commandFamilies: [
    {
      id: "session",
      title: "Session lifecycle",
      items: ["sessions", "session-create", "session-resume", "session-close", "session-artifacts"],
    },
    {
      id: "checkpoint",
      title: "Checkpoint",
      items: [
        "checkpoint-read",
        "checkpoint-write",
        "compress-checkpoint",
        "auto-compact-on-close",
      ],
    },
    {
      id: "sources",
      title: "Sources / Branches",
      items: [
        "sources",
        "set-working-branch",
        "workspace-init",
        "attach-multiroot",
        "detach-multiroot",
        "check-branch",
      ],
    },
    {
      id: "orchestration",
      title: "Orchestration",
      items: ["stack", "skill-index", "resume-summary"],
    },
    {
      id: "doctor",
      title: "Doctor / Data",
      items: [
        "plugin-doctor",
        "plugin-cache",
        "history-data",
        "history-update",
        "release-data",
        "code-scan",
        "project-md-upsert",
        "bootstrap-dsn",
      ],
    },
    {
      id: "hooks",
      title: "Hooks",
      items: ["hook branch-check", "hook sql-mutation-guard", "hook git-commit-advisor"],
    },
    {
      id: "mcp",
      title: "MCP",
      items: ["mcp dbhub", "mcp setup", "mcp remove", "mcp doctor", "mcp warp-status"],
    },
    {
      id: "dev",
      title: "Dev-only",
      items: ["harness", "profiles", "logs", "next-number"],
    },
    {
      id: "self",
      title: "Self",
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
    "/w:plan-exec",
    "/w:quick",
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
      fires: "checkpoint-write — preserves OBJECTIVE before compacting",
    },
    {
      name: "PostCompact",
      matcher: "(any)",
      fires: "resume-summary + prompt to reload CHECKPOINT.md",
    },
  ],
};
