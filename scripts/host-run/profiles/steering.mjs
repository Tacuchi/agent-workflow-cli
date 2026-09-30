// Workspace files whose content steers the CLI or a host outside the disposable
// root. A host editing one of them could point `aw` at a real repository (a
// source path) or give itself another directory or MCP server. Editing them
// asks the person, even though they sit inside the workspace; the session
// artifacts under .workflow/sessions/ stay editable.
//
// Swept from src (paths-service.ts, parsers/project-block.ts, workline-marker.ts,
// multiroot) and the hosts' own project-level config files:
// - CLAUDE.md, AGENTS.md: the WORKSPACE block with its Fuentes (BLOCK_MIRROR_FILES);
// - .workflow/local.json: per-machine source-path overrides (readWorkspaceLocalConfig);
// - .workflow/workline.json, skills.toml, processes.json, claims.jsonl,
//   doc-branches.jsonl: marker, capability bindings, process registry, claims
//   and document-branch ledgers;
// - the hosts' instruction files: AGENTS.override.md (codex), GEMINI.md and
//   .agent/** (agy), CRUSH.md and .crush/** (crush);
// - .git/**: hooks and config run by git itself;
// - project-level host configs: .claude/**, .mcp.json, .codex/**, .kimi-code/**
//   (local.toml: workspace.additional_dir), .gemini/**, .opencode/**,
//   opencode.json, .crush.json, crush.json, .warp/**.

export const STEERING_FILES = [
  "CLAUDE.md",
  "CLAUDE.local.md",
  "AGENTS.md",
  // Each host's own instruction files: codex, agy, crush.
  "AGENTS.override.md",
  "GEMINI.md",
  ".agent/**",
  "CRUSH.md",
  ".crush/**",
  ".gitignore",
  ".workflow/local.json",
  ".workflow/workline.json",
  ".workflow/skills.toml",
  ".workflow/processes.json",
  ".workflow/claims.jsonl",
  ".workflow/doc-branches.jsonl",
  ".git/**",
  ".claude/**",
  ".mcp.json",
  ".codex/**",
  ".kimi-code/**",
  ".gemini/**",
  ".opencode/**",
  "opencode.json",
  ".crush.json",
  "crush.json",
  ".warp/**",
];
