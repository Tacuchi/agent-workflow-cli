// Per-host facts the run needs and the catalog does not carry: which binary to
// launch, how its command wrappers are invoked, where its credentials live and
// how to ask it whether it is logged in.
//
// Host ids, install targets and MCP host ids are the catalog's (`HARNESSES` in
// src/domain/harnesses.ts); a guard test fails if this table drifts from it.

/** The six surfaces the matrix records, in the doctor's order. */
export const SURFACES = [
  "commands",
  "structured-choice",
  "hooks",
  "mcp",
  "host-memory",
  "compaction",
];

/** Every catalog host, covered or not, in catalog order. */
export const ALL_HOSTS = [
  "claude-code",
  "codex",
  "oz",
  "warp",
  "gemini",
  "opencode",
  "crush",
  "kimi",
];

/**
 * The spec admits only these two as not covered by the run. Anything else that
 * cannot be exercised stops the run and goes back to the person (T3.1).
 */
export const NOT_COVERED = {
  warp: "Warp ships no CLI a pane can launch: it is a desktop terminal app, so no run can drive it",
  oz: "oz is Warp's cloud agent orchestrator (a launcher shim inside Warp.app); it runs remotely and has no local interactive session to observe",
};

/**
 * Invocation per host follows «Command packaging» in skills/w/harness/HARNESS.md.
 *
 * `commandsVia` is the wrapper that invocation reaches: the host's own commands
 * dir, or the synthesized `w-<cmd>` skill (the fallback). It is what the commands
 * cell observes; the catalog is only compared with it afterwards.
 *
 * `compact` is the host's own compaction command, or null when it has none the
 * run can type; then the step sends the resume command and the cell is judged on
 * the declared fallback (CHECKPOINT + resume).
 */
export const HOSTS = {
  "claude-code": {
    commandsVia: "commands-dir",
    // `claude setup-token` prints a long-lived OAuth token meant for this variable
    // (claude 2.1.284 binary strings: CLAUDE_CODE_OAUTH_TOKEN; the alternatives it
    // also reads — ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN — are never used here).
    token: { env: "CLAUDE_CODE_OAUTH_TOKEN", flag: "--claude-token-file", label: "claude token" },
    // https://code.claude.com/docs/en/env-vars: `1` strips Anthropic and other
    // recognized credentials from the Bash tool, hooks and stdio MCP servers;
    // the claude process itself keeps them. Direct children only (no _DEEP).
    childEnv: { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1" },
    bin: "claude",
    installTarget: "claude",
    mcpHost: "claude",
    herdrKind: "claude",
    command: (cmd) => `/w:${cmd}`,
    compact: "/compact",
    // Claude keeps its login in the macOS keychain; the file only exists on Linux.
    credentials: [".claude/.credentials.json"],
    keychain: true,
    authProbe: ["auth", "status"],
    modelArgs: (model, effort) => [
      ...(model ? ["--model", model] : []),
      ...(effort ? ["--effort", effort] : []),
    ],
    exposes: { model: true, effort: true },
  },
  codex: {
    commandsVia: "skill",
    bin: "codex",
    installTarget: "codex",
    mcpHost: "codex",
    herdrKind: "codex",
    command: (cmd) => `$w-${cmd}`,
    compact: "/compact",
    credentials: [".codex/auth.json"],
    keychain: false,
    authProbe: ["login", "status"],
    modelArgs: (model, effort) => [
      ...(model ? ["-m", model] : []),
      ...(effort ? ["-c", `model_reasoning_effort=${effort}`] : []),
    ],
    exposes: { model: true, effort: true },
  },
  gemini: {
    probeSpendsPrompt: true,
    commandsVia: "skill",
    // agy 1.2.11 (binary strings, its embedded changelog): «Added support for
    // GEMINI_API_KEY, so the CLI can run against the Gemini API directly without
    // signing in. Set modelProvider: "gemini" in settings.json, export
    // GEMINI_API_KEY». A Gemini API key, not the person's Google sign-in; when it
    // is given, the profile also sets modelProvider "gemini".
    token: { env: "GEMINI_API_KEY", flag: "--agy-token-file", label: "agy Gemini API key" },
    bin: "agy",
    installTarget: "gemini",
    mcpHost: "gemini",
    herdrKind: "agy",
    // agy reads no commands dir: the synthesized w-<cmd> skill is named in the prompt.
    command: (cmd) => `Use the w-${cmd} skill.`,
    compact: null,
    // agy loads its token from the system keyring and falls back to a file whose
    // path the binary does not name; only the probe can tell.
    credentials: [],
    keychain: true,
    // No status subcommand: one print-mode turn is the cheapest proof of login.
    authProbe: ["-p", "Reply with the single word ok.", "--print-timeout", "60s"],
    modelArgs: (model, effort) => [
      ...(model ? ["--model", model] : []),
      ...(effort ? ["--effort", effort] : []),
    ],
    exposes: { model: true, effort: true },
  },
  opencode: {
    commandsVia: "commands-dir",
    bin: "opencode",
    installTarget: "opencode",
    mcpHost: "opencode",
    herdrKind: "opencode",
    command: (cmd) => `/w/${cmd}`,
    compact: "/compact",
    credentials: [".local/share/opencode/auth.json"],
    keychain: false,
    authProbe: ["auth", "list"],
    modelArgs: (model) => (model ? ["--model", model] : []),
    exposes: { model: true, effort: false },
  },
  crush: {
    probeSpendsPrompt: true,
    commandsVia: "commands-dir",
    bin: "crush",
    installTarget: "crush",
    mcpHost: "crush",
    // Herdr 0.9.0 has no crush kind: its state is read from the screen only.
    herdrKind: null,
    command: (cmd) => `user:w:${cmd}`,
    palette: true,
    compact: null,
    credentials: [".local/share/crush/crush.json"],
    keychain: false,
    authProbe: ["run", "Reply with the single word ok."],
    modelArgs: () => [],
    exposes: { model: false, effort: false },
  },
  kimi: {
    probeSpendsPrompt: true,
    commandsVia: "skill",
    bin: "kimi",
    installTarget: "kimi",
    mcpHost: "kimi",
    herdrKind: "kimi",
    ownBinDir: true,
    command: (cmd) => `/skill:w-${cmd}`,
    compact: "/compact",
    credentials: [".kimi-code/credentials", ".kimi-code/oauth", ".kimi-code/device_id"],
    keychain: false,
    authProbe: ["-p", "Reply with the single word ok."],
    modelArgs: (model) => (model ? ["-m", model] : []),
    exposes: { model: true, effort: false },
  },
};

export const COVERED_HOSTS = Object.keys(HOSTS);

/** Every variable that carries a host token: never in any env but its own host's wrapper. */
export const TOKEN_VARS = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
];
