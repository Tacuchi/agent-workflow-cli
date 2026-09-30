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
 * Hosts no run covers, each with its reason (recorded in every matrix). warp and
 * oz cannot be driven; kimi was excluded by the person. Anything else that
 * cannot be exercised stops the run and goes back to the person (T3.1). An
 * excluded host keeps its entry in HOSTS and its profile, out of every run.
 */
export const NOT_COVERED = {
  warp: "Warp ships no CLI a pane can launch: it is a desktop terminal app, so no run can drive it",
  oz: "oz is Warp's cloud agent orchestrator (a launcher shim inside Warp.app); it runs remotely and has no local interactive session to observe",
  kimi: "subscription cancelled by the person (2026-09-29): excluded from every run until they subscribe again",
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
    // Required: the keychain login does not reach a disposable home, so without
    // the token the auth check says so and spends no probe on claude.
    token: {
      env: "CLAUDE_CODE_OAUTH_TOKEN",
      flag: "--claude-token-file",
      label: "claude token",
      required: true,
      absent:
        "token absent (CLAUDE_CODE_OAUTH_TOKEN not set in this shell; export it in the same terminal or use --claude-token-file)",
    },
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
    // A bare `$w-doctor` leaves codex's skill completion open and Enter picks the
    // item instead of submitting: in run 3 `$w-doctor` stayed in the input and the
    // next step's text was appended to it («$w-doctor $w-quick …», «$w-recall
    // /compact»). With text after the mention, the prompt is submitted.
    bare: (cmd) => `$w-${cmd} (no arguments)`,
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
    // No token and no key: agy runs on the person's own login, done inside its
    // pane when the run starts (their decision, s280). No probe runs for it — an
    // agy probe without a login opens the OAuth flow (agy 1.1.2+ reads the code
    // from /dev/tty in print mode), which is how a code reached the terminal.
    signInInPane: true,
    bin: "agy",
    installTarget: "gemini",
    mcpHost: "gemini",
    herdrKind: "agy",
    // agy reads no commands dir: the synthesized w-<cmd> skill is named in the prompt.
    command: (cmd) => `Use the w-${cmd} skill.`,
    compact: null,
    // Nothing is copied: agy keeps its login in the macOS login keychain (per
    // user, not per HOME; agy strings: KeyringTokenStorage, «Keyring SaveToken
    // timed out …, falling back to file storage»). The person accepted that the
    // pane uses, and may overwrite, that real entry (KEYCHAIN_NOTICE).
    credentials: [],
    keychainNotice:
      "agy stores its login in your macOS login keychain (per user, not per HOME): the pane may reuse your existing agy login, and signing in or a token refresh may overwrite it; /logout in the pane would remove it",
    keychainState: "real (accepted by the person)",
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
    // One model turn with the model the pane runs: `auth list` only proves a file
    // exists (run 3 started on a default model with no quota).
    probeSpendsPrompt: true,
    authProbe: ["run", "Reply with the single word ok."],
    probeModelFlag: "-m",
    // The person uses OpenAI in opencode; its opencode.json (with their model) is
    // not copied, so the run names one from opencode's own catalog (models.dev,
    // provider `openai`, `env: ["OPENAI_API_KEY"]`, model `gpt-6-luna`, released
    // 2026-09-22, tool calls). `--model opencode=<provider/model>` overrides it.
    defaultModel: "openai/gpt-6-luna",
    tokenChoices: [
      {
        env: "OPENAI_API_KEY",
        flag: "--opencode-openai-key-file",
        label: "opencode OpenAI API key",
        provider: "openai",
        model: "gpt-6-luna",
        absent:
          "no OpenAI key: opencode uses your copied sign-in (auth.json) with openai/gpt-6-luna; or give --opencode-openai-key-file / OPENAI_API_KEY",
      },
    ],
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
    // crush 0.96.1 (internal/config/init.go): a project with files and no context
    // file asks «Would you like to initialize now?» unless `<data dir>/init`
    // exists; the project data dir is `<workspace>/.crush`.
    workspaceSeeds: [{ rel: ".crush/init", text: '{"initialized":true}\n' }],
    // crush 0.96.1 source (internal/cmd/root.go): `useClientServer()` is true
    // only when CRUSH_CLIENT_SERVER parses true; otherwise the app runs
    // in-process and no detached `crush server` (startDetachedServer, Setsid)
    // is started. Set false explicitly. CRUSH_DISABLE_PROVIDER_AUTO_UPDATE
    // (internal/config/load.go, ParseBool) keeps the embedded Catwalk catalog,
    // so the provider list and the model id stay fixed during a run.
    childEnv: { CRUSH_CLIENT_SERVER: "0", CRUSH_DISABLE_PROVIDER_AUTO_UPDATE: "1" },
    // A provider key through the same wrapper as a token, first present wins
    // (Gemini first: free from Google AI Studio). Provider and model come from
    // crush 0.96.1's embedded Catwalk catalog (binary strings): provider `gemini`
    // (`"api_key": "$GEMINI_API_KEY"`, `default_small_model_id`
    // "gemini-3-flash-preview") and `openai` (`"api_key": "$OPENAI_API_KEY"`,
    // `default_small_model_id` "gpt-5.6-luna"). With a key, the person's own
    // crush data (its model selection) is not copied, so it cannot override.
    tokenChoices: [
      {
        env: "GEMINI_API_KEY",
        flag: "--crush-gemini-key-file",
        label: "crush Gemini API key",
        provider: "gemini",
        model: "gemini-3-flash-preview",
        absent:
          "no provider key: crush falls back to your own crush data; set GEMINI_API_KEY (free, Google AI Studio) or use --crush-gemini-key-file",
      },
      {
        env: "OPENAI_API_KEY",
        flag: "--crush-openai-key-file",
        label: "crush OpenAI API key (paid)",
        provider: "openai",
        model: "gpt-5.6-luna",
      },
    ],
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

/** The hosts a run launches: every HOSTS entry that is not declared not covered. */
export const COVERED_HOSTS = Object.keys(HOSTS).filter((h) => !(h in NOT_COVERED));

/**
 * The token spec a host uses: its single `token`, or the first of its
 * `tokenChoices` whose value is present (`present(spec)` → boolean), else the
 * first choice. null for a host that takes none.
 */
export function tokenSpec(hostId, present = () => false) {
  const host = HOSTS[hostId];
  if (host.token) return host.token;
  if (!host.tokenChoices) return null;
  return host.tokenChoices.find((c) => present(c)) ?? host.tokenChoices[0];
}

/** Every token spec a host can take (flags and variables), for parsing and scrubbing. */
export const tokenSpecs = (hostId) =>
  HOSTS[hostId].token ? [HOSTS[hostId].token] : (HOSTS[hostId].tokenChoices ?? []);

/** Every variable that carries a host token: never in any env but its own host's wrapper. */
export const TOKEN_VARS = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENAI_API_KEY",
];
