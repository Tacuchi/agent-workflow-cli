// Datos del Workflow tab — hardcoded para evitar I/O en render.
// Sincronizado con (verificado en T4):
//   - skills/agent-workflow/SKILL.md (familias de comandos)
//   - skills/agent-workflow/commands/   (17 slash commands)
//   - skills/agent-workflow/hooks/hooks.template.json (5 eventos)
//   - aw --help (familias del CLI real)
//
// Puntos de drift: si se agregan/quitan slash commands en `commands/` o se
// renombran familias en SKILL.md, actualizar este archivo. Los totales se
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
  overview: "Universal session-lifecycle harness — 11 familias, 17 slash commands, 5 hooks.",

  // 5-phase user-facing lifecycle.
  phases: [
    {
      id: "discover",
      n: 1,
      title: "Discover",
      desc: "Detectar estado del workspace — sources, branches, modo, stack.",
      commands: ["sources", "workspace-mode", "sessions"],
      slash: "—",
      hook: "—",
    },
    {
      id: "start",
      n: 2,
      title: "Start",
      desc: "Abrir una sesión tracked con OBJETIVO + flow (core/dev/design).",
      commands: ["session-create", "session-resume"],
      slash: "/agent-workflow:session",
      hook: "SessionStart",
    },
    {
      id: "plan",
      n: 3,
      title: "Plan",
      desc: "Elegir profundidad de planning + detectar fase.",
      commands: ["auto-plan-decide", "phase-detect", "specialty-choose"],
      slash: "/agent-workflow:rules",
      hook: "—",
    },
    {
      id: "work",
      n: 4,
      title: "Work",
      desc: "Persistir progreso en CHECKPOINT.md. Drift guardado por topic-change.",
      commands: ["checkpoint-write", "topic-change-check", "tasks-data"],
      slash: "/agent-workflow:compact",
      hook: "PreToolUse · PreCompact · PostCompact",
    },
    {
      id: "close",
      n: 5,
      title: "Close / Graduate",
      desc: "Cerrar la sesión + exportar artefactos. Handoff o release.",
      commands: ["session-close", "release-data", "graduate"],
      slash: "/agent-workflow:resume",
      hook: "SessionEnd",
    },
  ],

  // 11 command families verificadas contra `aw --help`.
  commandFamilies: [
    {
      id: "session",
      title: "Session mgmt",
      items: ["sessions", "session-create", "session-resume", "session-close", "session-artifacts"],
    },
    {
      id: "objetivo",
      title: "Objetivo / Tasks",
      items: ["objetivo-data", "tasks-data", "decisiones-list", "dependencias-list"],
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
      title: "Sources / branches",
      items: ["sources", "attach-multiroot", "detach-multiroot", "check-branch"],
    },
    {
      id: "orchestration",
      title: "Orchestration",
      items: [
        "phase-detect",
        "phase-next",
        "workflows",
        "workspace-mode",
        "stack",
        "skill-index",
        "auto-plan-decide",
        "topic-change-check",
        "specialty-choose",
        "resume-summary",
      ],
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
        "graduate",
        "upgrade-hub-mode",
      ],
    },
    {
      id: "hooks",
      title: "Hooks (cli)",
      items: ["hook branch-check", "hook sql-mutation-guard", "hook git-commit-advisor"],
    },
    {
      id: "mcp",
      title: "MCP / DSN",
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
    {
      id: "other",
      title: "Other",
      items: ["graduation-check", "hub-init", "visibility"],
    },
  ],

  // 17 slash commands — `ls skills/agent-workflow/commands/*.md`.
  slashCommands: [
    "/agent-workflow:session",
    "/agent-workflow:resume",
    "/agent-workflow:compact",
    "/agent-workflow:doctor",
    "/agent-workflow:rules",
    "/agent-workflow:migrate",
    "/agent-workflow:project-init",
    "/agent-workflow:hub-init",
    "/agent-workflow:export-plan",
    "/agent-workflow:export-arq",
    "/agent-workflow:export-report",
    "/agent-workflow:export-conclusions",
    "/agent-workflow:export-scripts",
    "/agent-workflow:export-requirement",
    "/agent-workflow:export-qa-note",
    "/agent-workflow:export-tech-note",
    "/agent-workflow:export-tech-manuals",
  ],

  // 5 hooks de hooks.template.json — matcher real + qué disparan.
  hooks: [
    {
      name: "SessionStart",
      matcher: "startup|resume|clear",
      fires: "Inject namespace en ~/.config/agent-workflow/namespace",
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
      fires: "checkpoint-write — preserva OBJETIVO antes de compactar",
    },
    {
      name: "PostCompact",
      matcher: "(any)",
      fires: "resume-summary + prompt para re-cargar CHECKPOINT.md",
    },
  ],
};
