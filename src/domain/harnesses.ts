import { HOST_VERIFICATIONS, type HarnessVerification } from "./host-verification.js";
import type { McpHost } from "./mcp-entry.js";

export type Harness =
  | "claude-code"
  | "codex"
  | "warp"
  | "oz"
  | "gemini"
  | "opencode"
  | "crush"
  | "kimi"
  | "unknown";

/** A real host id. `unknown` is a detection outcome, never a catalog entry. */
export type HarnessId = Exclude<Harness, "unknown">;

// Canonical key used as TARGET_ROOTS key in install-skill (re-exported there).
// It is the union of the HOST targets (one per HarnessSpec) and the SHARED
// destinations (`agents`) — a shared dir is a valid place to install, never a
// host. `HOST_INSTALL_TARGETS` / `SHARED_INSTALL_TARGETS` split them below.
export type InstallTarget =
  | "claude"
  | "codex"
  | "agents"
  | "warp"
  | "oz"
  | "gemini"
  | "opencode"
  | "crush"
  | "kimi";

/**
 * Declared support level. `official` = validated per release by the host smoke
 * suite (`npm run smoke:hosts`); `best-effort` = installation and docs are kept,
 * validation is not run on every release (spec 010 § Decisions).
 */
export type SupportTier = "official" | "best-effort";

export interface HarnessSupport {
  tier: SupportTier;
  /** Pre-1.0 host: its published surface can change between releases. */
  unstableSurface?: boolean;
}

/**
 * How to prove the host's RUNTIME is actually available — a state of its own,
 * independent of whether its config dir exists (a config dir survives an
 * uninstall) and of whether it exported an env marker (several hosts export
 * none).
 */
export interface HarnessRuntime {
  /**
   * Executables tried on PATH, in order (a host can rename its CLI: Gemini's
   * successor ships as `agy`). EMPTY = this host ships no CLI of its own (Warp
   * is a GUI app), so runtime availability is not probe-able and the detection
   * says exactly that instead of guessing.
   */
  bins: readonly string[];
  /**
   * Absolute locations (`~`-prefixed) tried when no `bins` entry is on PATH.
   * Kimi Code installs to `~/.kimi-code/bin`, which only interactive shells add.
   */
  fallbackBinPaths?: readonly string[];
  /** Args that make the binary print its version. */
  versionArgs: readonly string[];
}

export interface HarnessHooks {
  /** How this host declares hooks, as verified against its docs/source. */
  mechanism: string;
  /** True when Workline installs and removes its hook set on this host. */
  managed: boolean;
}

/**
 * Where the host keeps its global configuration — the observable behind the
 * "config present" state.
 */
export type HarnessConfigDir =
  /** A literal dir, `~`-prefixed. */
  | { kind: "dir"; path: string }
  /** The parent of its global MCP config file (platform-divergent hosts derive it from `globalMcpPaths` — one registry, no second source). */
  | { kind: "mcp-parent" }
  /** The host keeps no config dir of its own; `reason` is shown instead of inventing a path. */
  | { kind: "none"; reason: string };

// Platform-specific global MCP config paths. `~` is a placeholder expanded at runtime.
export interface HarnessGlobalMcpPaths {
  darwin: string;
  linux: string;
  win32: string;
}

/**
 * How a person reaches a top-level capability skill ON THIS HOST.
 *
 * Discovery renders this and nothing else. Announcing `/design` on a host that
 * has no slash form is worse than saying nothing: the person types it, gets
 * silence, and concludes the capability is broken. So the form is DATA, verified
 * per host, and a host that cannot load a top-level skill declares `null` rather
 * than borrowing another host's syntax.
 *
 * `template` carries `<name>` as the placeholder, the same convention `~` uses
 * for home in this file.
 */
export interface HarnessInvocation {
  /** `slash` = a typed command form. `mention` = the model activates it by description. */
  kind: "slash" | "mention";
  template: string;
  /** What this claim rests on. A form nobody verified is a form nobody should print. */
  note: string;
}

/**
 * What a host's structured-choice really is TODAY, as the single source the
 * installer stamps and the surfaces project.
 *
 * It exists because the doctrine alone cannot carry this: `HARNESS.md` documents
 * the binding per host, but every wrapper we install ships the same neutral text,
 * so nothing tells the agent which host it is running on or which mechanism to
 * reach for. Installation is the one moment the target IS known, so the binding is
 * stamped there — and a stamp can only be generated from data.
 *
 * The three states are the same vocabulary `capabilitiesFor` already projects, and
 * they answer one question: which mechanism does a boundary use HERE.
 *
 * - `native` — the tool is reachable and it is what a boundary uses; labeled
 *   markdown is the fallback for the cases `fallbackReason` names.
 * - `degraded` — the mechanism exists in the runtime but is NOT reachable in the
 *   mode Workline runs in, so markdown is the operative mechanism. Kept apart from
 *   `unsupported` because the difference is actionable: there is an opt-in to name.
 * - `unsupported` — no mechanism at all; markdown, always.
 */
export type StructuredChoiceState = "native" | "degraded" | "unsupported";

export interface HarnessStructuredChoice {
  state: StructuredChoiceState;
  /** The host's native tool, when it has one at all — even one it does not reach. */
  tool: string | null;
  /**
   * Per-call ceilings the host DECLARES. `null` means it declares none, and that is
   * not an invitation to infer one: an invented ceiling silently drops questions.
   */
  ceilings: { questions: number; options: number } | null;
  /** Where an option's functional sentence goes: its own field, or folded into the label. */
  sentence: "field" | "in-label";
  /** Cap the host puts on that sentence, when it caps it. `null` = uncapped. */
  sentenceMaxChars: number | null;
  /** The tool already offers a free-text answer → never add a duplicate `Other`. */
  customAnswer: boolean;
  /**
   * Read against `state`: for `native`, WHEN labeled markdown takes over; for the
   * other two, WHY it always does. One field, because a boundary only ever needs
   * one answer — "under what condition am I not using the native mechanism".
   */
  fallbackReason: string;
  /** What the claim rests on — doc, installed runtime or a real run — with its date. */
  evidence: string;
}

/** The mention form every host that auto-discovers skills by description shares. */
const MENTION: HarnessInvocation = {
  kind: "mention",
  template: "<name>",
  note: "las skills se activan por su description: se nombra la capacidad en la conversación",
};

export interface HarnessSpec {
  id: HarnessId;
  // Long label every projection renders (TUI cards, docs tables, CLI describes).
  label: string;
  // 1-letter glyph for compact chips. Unique across the catalog (guard-enforced).
  glyph: string;
  // Declared support level. What a RUN proved lives in the verification ledger.
  support: HarnessSupport;
  // How to probe that the runtime is really invocable on this machine.
  runtime: HarnessRuntime;
  // Where the host keeps its global config (the "config present" observable).
  configDir: HarnessConfigDir;
  // The host's hook system, or null when it has none at all (Warp/Oz, DEC-W4).
  // `managed` = Workline installs and removes its hook set there; it is the
  // SINGLE source for that fact (`HOOKS_MANAGED_TARGETS` derives from it), so
  // installer, hook writer and uninstaller cannot disagree about which hosts
  // get hooks.
  hooks: HarnessHooks | null;
  // Env vars (any one present → this harness). Checked first-match in order.
  // EMPTY is legitimate: a host may export no marker to its subprocesses (Kimi
  // Code), in which case detection falls back to binary + config (see
  // `runtimeProbe`) and `runHarness` legitimately answers `unknown`.
  envMarkers: readonly string[];
  // TERM_PROGRAM value that also triggers detection (e.g. "WarpTerminal")
  termProgramMatch?: string;
  // null → harness does not write an MCP config file (e.g. Oz emits via --mcp flag)
  mcpHostId: McpHost | null;
  // Absolute-path template for global MCP config, by platform + channel
  globalMcpPaths?: HarnessGlobalMcpPaths;
  // Relative path from project root for project-scoped MCP config
  projectMcpPath?: string;
  // Relative path to plugin manifest from project root; null = no manifest
  pluginManifest: string | null;
  // Subdirectory name under project root for hooks; null = no hooks
  pluginHooksDir: string | null;
  // Directories where skills are auto-discovered (relative to project root)
  skillsDirs: readonly string[];
  // Primary install destination used by install-skill
  installTarget: InstallTarget;
  /**
   * The form a capability skill is really invoked with here, or null when this
   * host cannot load a top-level skill at all. Discovery prints exactly this.
   */
  invocation: HarnessInvocation | null;
  /**
   * How a human boundary is really presented here. Single source for the install
   * stamp and for the state every surface projects; `chassis-consistency` asserts
   * it agrees with the `structured-choice` row of `HARNESS.md`.
   */
  structuredChoice: HarnessStructuredChoice;
}

export const HARNESSES: readonly HarnessSpec[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    glyph: "C",
    support: { tier: "official" },
    runtime: { bins: ["claude"], versionArgs: ["--version"] },
    configDir: { kind: "dir", path: "~/.claude" },
    hooks: { mechanism: "~/.claude/settings.json → hooks{}", managed: true },
    envMarkers: ["CLAUDECODE", "CLAUDE_PLUGIN_ROOT", "CLAUDE_AGENT_ID"],
    mcpHostId: "claude",
    globalMcpPaths: {
      darwin: "~/.claude.json",
      linux: "~/.claude.json",
      win32: "~/.claude.json",
    },
    projectMcpPath: ".mcp.json",
    pluginManifest: ".claude-plugin/plugin.json",
    pluginHooksDir: "hooks",
    skillsDirs: [".claude/skills"],
    installTarget: "claude",
    invocation: MENTION,
    structuredChoice: {
      state: "native",
      tool: "AskUserQuestion",
      ceilings: { questions: 4, options: 4 },
      sentence: "field",
      sentenceMaxChars: null,
      customAnswer: true,
      fallbackReason:
        "the call fails, or the asker is a subagent (the tool belongs to the main agent only)",
      evidence:
        "official docs 2026-08-02; the binding in daily use, and the regression plan 016 preserves",
    },
  },
  {
    id: "codex",
    label: "Codex",
    glyph: "X",
    support: { tier: "official" },
    runtime: { bins: ["codex"], versionArgs: ["--version"] },
    configDir: { kind: "dir", path: "~/.codex" },
    // Codex HAS hooks, in a different format (TOML) with no settled user-level
    // syntax — declared, not managed: the surfaces say "available, not armed"
    // instead of pretending the host has none.
    hooks: { mechanism: "~/.codex/config.toml (plugin hooks/hooks.json)", managed: false },
    envMarkers: ["CODEX_HOME", "CODEX_CLI", "CODEX_RUNTIME"],
    mcpHostId: "codex",
    globalMcpPaths: {
      darwin: "~/.codex/config.toml",
      linux: "~/.codex/config.toml",
      win32: "~/.codex/config.toml",
    },
    projectMcpPath: ".codex/config.toml",
    pluginManifest: ".codex-plugin/plugin.json",
    // Codex plugin bundles ship hooks at `hooks/hooks.json` in the plugin root
    // (env PLUGIN_ROOT), same layout as Claude's `hooks/`. Verified 2026-07 vs
    // developers.openai.com/codex/hooks.
    pluginHooksDir: "hooks",
    // Codex loads Agent Skills from `.agents/skills` (the open-standard dir,
    // ~/.agents/skills global) — this is primary. `.codex/skills` kept as a
    // secondary for older builds. Verified vs developers.openai.com/codex/skills.
    skillsDirs: [".agents/skills", ".codex/skills"],
    installTarget: "codex",
    invocation: MENTION,
    // `degraded`, not `unsupported`: the tool IS in the runtime (its own router and
    // TUI renderer name it), so what is missing is reachability — and that has an
    // opt-in worth naming instead of a capability worth denying.
    structuredChoice: {
      state: "degraded",
      tool: "request_user_input",
      ceilings: { questions: 3, options: 3 },
      sentence: "field",
      sentenceMaxChars: null,
      customAnswer: false,
      fallbackReason:
        "its router refuses the call in Default mode (`request_user_input is unavailable in Default mode`) and exec mode never offers it, while the opt-in `default_mode_request_user_input` is still under development",
      evidence:
        "probe 2026-08-04 on codex-cli 0.146.0: a real run hit the router refusal and the model listed its own tool set without it; `codex features list` reports the opt-in as 'under development false'",
    },
  },
  {
    // Detection: OZ_RUN_ID takes priority over warp markers to handle overlap.
    // Keep oz before warp in the array so first-match detection picks oz first
    // when both OZ_RUN_ID and TERM_PROGRAM=WarpTerminal are set.
    id: "oz",
    label: "Oz",
    glyph: "Z",
    support: { tier: "best-effort", unstableSurface: true },
    // Oz ships inside Warp.app (…/Contents/Resources/bin/oz) and Warp puts that
    // dir on PATH — so the binary IS probe-able even though ~/.oz never exists.
    runtime: { bins: ["oz"], versionArgs: ["--version"] },
    configDir: {
      kind: "none",
      reason: "Oz runs inside Warp's environment and keeps no config dir of its own",
    },
    hooks: null, // DEC-W4: no hook system.
    envMarkers: ["OZ_RUN_ID"],
    mcpHostId: null, // Oz does not write a config file; emits JSON for --mcp flag
    pluginManifest: null,
    pluginHooksDir: null,
    skillsDirs: [".agents/skills"],
    installTarget: "oz",
    invocation: MENTION,
    structuredChoice: {
      state: "unsupported",
      tool: null,
      ceilings: null,
      sentence: "in-label",
      sentenceMaxChars: null,
      customAnswer: false,
      fallbackReason:
        "its launcher is a 122-byte Bash shim inside Warp.app, with no tool surface of its own to reach",
      evidence:
        "probe 2026-08-04 on oz v0.2026.07.29.09.05: the shim carries no question-tool name at all",
    },
  },
  {
    id: "warp",
    label: "Warp Terminal",
    glyph: "W",
    support: { tier: "official" },
    // No `warp` CLI exists: it is a GUI terminal. Runtime availability is
    // therefore not probe-able — the detection reports that, it does not guess.
    runtime: { bins: [], versionArgs: [] },
    configDir: { kind: "mcp-parent" },
    hooks: null, // DEC-W4: no hook system.
    envMarkers: ["WARP_IS_LOCAL_SHELL_SESSION"],
    termProgramMatch: "WarpTerminal",
    mcpHostId: "warp",
    globalMcpPaths: {
      // DEC-W3: Warp uses .mcp.json (JSON), not settings.toml, for MCP config.
      // Warp Preview builds (researched, unwired): ~/.warp-preview/.mcp.json ·
      // ~/.config/warp-terminal-preview/.mcp.json · %LOCALAPPDATA%/warp/WarpPreview/config/.mcp.json
      darwin: "~/.warp/.mcp.json",
      linux: "~/.config/warp-terminal/.mcp.json",
      win32: "%LOCALAPPDATA%/warp/Warp/config/.mcp.json",
    },
    projectMcpPath: ".warp/.mcp.json",
    pluginManifest: null, // DEC-W2: no plugin manifest convention for Warp
    pluginHooksDir: null, // DEC-W4: no hooks system in Warp/Oz
    // Warp lists slash commands from top-level subdirectories of ~/.warp/skills/
    // (each one must contain SKILL.md with `name:` frontmatter). The installer
    // synthesizes each bundle command as a top-level `w-<command>` skill
    // (skill-as-command). See install-skill.ts:synthesizeCommandSkills.
    skillsDirs: [".warp/skills", ".agents/skills", ".claude/skills", ".codex/skills"],
    installTarget: "warp",
    invocation: MENTION,
    structuredChoice: {
      state: "unsupported",
      tool: null,
      ceilings: null,
      sentence: "in-label",
      sentenceMaxChars: null,
      customAnswer: false,
      fallbackReason: "no structured-choice surface is documented for it",
      evidence: "official docs 2026-08-02; it ships no CLI, so there is nothing local to probe",
    },
  },
  {
    // Gemini CLI (deprecated mid-2026) + Antigravity CLI (`agy`, successor;
    // reuses ~/.gemini/). agy 1.0.16 (verified vs binary + bundled
    // agy-customizations doc): NO user commands — slash commands are
    // system-only, the ~/.gemini/commands/*.toml dir is legacy Gemini CLI
    // only; skills are the invocable unit, tiers Workspace <repo>/.agents/
    // skills · Global ~/.gemini/antigravity-cli/skills · Shared
    // ~/.gemini/skills (agy does NOT read user-level ~/.agents/skills).
    // ANTIGRAVITY_* markers are the env vars agy exports to subprocesses.
    // MCP in settings.json (mcpServers, Claude-compatible shape).
    id: "gemini",
    label: "Gemini CLI / Antigravity",
    glyph: "G",
    support: { tier: "official" },
    // `agy` is the live binary; `gemini` is the deprecated CLI that shares
    // ~/.gemini. Probed in that order so the successor wins.
    runtime: { bins: ["agy", "gemini"], versionArgs: ["--version"] },
    configDir: { kind: "dir", path: "~/.gemini" },
    hooks: { mechanism: "extension-bundled (BeforeTool)", managed: false },
    envMarkers: [
      "GEMINI_CLI",
      "GEMINI_SANDBOX",
      "ANTIGRAVITY",
      "ANTIGRAVITY_CLI",
      "ANTIGRAVITY_CONVERSATION_ID",
      "ANTIGRAVITY_PROJECT_ID",
    ],
    mcpHostId: "gemini",
    globalMcpPaths: {
      darwin: "~/.gemini/settings.json",
      linux: "~/.gemini/settings.json",
      win32: "~/.gemini/settings.json",
    },
    projectMcpPath: ".gemini/settings.json",
    pluginManifest: null, // Gemini uses Extensions (gemini-extension.json) — Phase 2
    pluginHooksDir: null, // Extension-bundled hooks (BeforeTool) — Phase 2
    skillsDirs: [".agents/skills", ".gemini/skills"],
    installTarget: "gemini",
    invocation: MENTION,
    // The tool is `AskQuestion`, NOT the deprecated Gemini CLI's `ask_user`: the
    // live binary here is `agy`, and `ask_user` does not appear in it at all.
    // Naming the retired one would stamp a tool no installed host answers to.
    structuredChoice: {
      state: "native",
      tool: "AskQuestion",
      ceilings: null,
      // `AskQuestionOption` carries `id` and `text` and nothing else — there is no
      // field for the sentence, so it rides inside the visible option string.
      sentence: "in-label",
      sentenceMaxChars: null,
      customAnswer: true,
      fallbackReason: "the call fails or the host disables the tool (`AskQuestionToolConfig`)",
      evidence:
        "probe 2026-08-04 on agy 1.0.16 (Antigravity, the successor that reuses ~/.gemini): its shipped proto declares `AskQuestionEntry` with `options`, `is_multi_select` and `write_in_response`, and `AskQuestionOption` with `id` + `text` only; no per-call ceiling is declared anywhere. The run itself is unverified — `agy --print` returned nothing within 150s",
    },
  },
  {
    // OpenCode (sst/opencode). Config `opencode.json` ($schema); MCP under `mcp`
    // (type "local", command as array, `environment`). Reads .claude/skills and
    // .agents/skills directly. Enforcement via JS plugins (tool.execute.before) — Phase 2.
    id: "opencode",
    label: "OpenCode",
    glyph: "O",
    support: { tier: "best-effort" },
    runtime: { bins: ["opencode"], versionArgs: ["--version"] },
    configDir: { kind: "mcp-parent" },
    hooks: { mechanism: "JS/TS plugins (tool.execute.before)", managed: false },
    envMarkers: ["OPENCODE", "OPENCODE_BIN", "OPENCODE_CONFIG"],
    mcpHostId: "opencode",
    globalMcpPaths: {
      darwin: "~/.config/opencode/opencode.json",
      linux: "~/.config/opencode/opencode.json",
      win32: "~/.config/opencode/opencode.json",
    },
    projectMcpPath: "opencode.json",
    pluginManifest: null, // JS/TS plugins in .opencode/plugin — Phase 2
    pluginHooksDir: null,
    skillsDirs: [".opencode/skills", ".agents/skills", ".claude/skills"],
    installTarget: "opencode",
    invocation: MENTION,
    structuredChoice: {
      state: "native",
      tool: "question",
      ceilings: null,
      sentence: "field",
      sentenceMaxChars: null,
      customAnswer: true,
      fallbackReason:
        "a non-interactive run (`opencode run`) starts with the `question` permission set to `deny`, or the call fails",
      evidence:
        "probe 2026-08-04 on opencode 1.18.5: `QuestionOption` carries its own `label` and `description`, `custom` defaults to true, and no count ceiling is declared; the exported session of a real `run` showed `question` denied",
    },
  },
  {
    // Crush (charmbracelet/crush). Config `crush.json` ($schema charm.land/crush.json);
    // MCP under `mcp` (type "stdio"). Reads .agents/skills + .claude/skills. Hooks are
    // preliminary; enforcement via `allowed_tools` allowlist — Phase 3.
    // Global config verified 2026-07 (README charmbracelet/crush): Unix XDG,
    // Windows %LOCALAPPDATA%\crush\crush.json (override CRUSH_GLOBAL_CONFIG).
    id: "crush",
    label: "Crush",
    glyph: "R",
    support: { tier: "best-effort", unstableSurface: true },
    runtime: { bins: ["crush"], versionArgs: ["--version"] },
    configDir: { kind: "mcp-parent" },
    hooks: { mechanism: "preliminary; enforcement via allowed_tools allowlist", managed: false },
    envMarkers: ["CRUSH", "CRUSH_CONFIG"],
    mcpHostId: "crush",
    globalMcpPaths: {
      darwin: "~/.config/crush/crush.json",
      linux: "~/.config/crush/crush.json",
      win32: "%LOCALAPPDATA%/crush/crush.json",
    },
    projectMcpPath: "crush.json",
    pluginManifest: null,
    pluginHooksDir: null,
    // Global roots are XDG (~/.config/crush + ~/.config/agents); .crush/skills
    // is PROJECT-relative only (crush v0.81.0 GlobalSkillsDirs/projectSkillSubdirs).
    // The resolver applies each dir under cwd AND home, so both scopes stay covered.
    skillsDirs: [
      ".config/crush/skills",
      ".config/agents/skills",
      ".agents/skills",
      ".crush/skills",
      ".claude/skills",
    ],
    installTarget: "crush",
    invocation: MENTION,
    structuredChoice: {
      state: "native",
      tool: "question",
      ceilings: { questions: 5, options: 5 },
      sentence: "field",
      // The one host that CAPS the sentence. It matters: a consequence longer than
      // this cannot be shortened to fit without losing content, which is a
      // degradation to declare, not a trim to perform quietly.
      sentenceMaxChars: 100,
      customAnswer: true,
      fallbackReason: "the call fails, or an option's consequence does not fit that cap",
      evidence:
        "probe 2026-08-04 on crush v0.87.0: ceilings 5×5, a description required on every question (<300 chars) and on every choice (<100 chars), and an automatic fill-in option, all read from the installed binary; the run itself could not be verified (expired auth)",
    },
  },
  {
    // Kimi Code (MoonshotAI) — successor of the Python `kimi-cli`, shipped as a
    // single Node SEA binary. Everything below was verified 2026-07-29 against
    // the shipped v0.29.2 binary (its JS is readable) plus live probes:
    //   · skills, 4 tiers: user `<KIMI_CODE_HOME>/skills` + `~/.agents/skills`,
    //     project `.kimi-code/skills` + `.agents/skills`. Probe: a skill dropped
    //     in ~/.agents/skills was listed AND invoked as `/skill:<name>`.
    //   · hooks in `[[hooks]]` of the USER-GLOBAL config.toml only — there is no
    //     project-level config.toml (probe: a project hook never fired). Schema
    //     is event/matcher/command/timeout, strict — NOT Claude's shape.
    //   · MCP `mcp.json` with the Claude-compatible `mcpServers` wrapper: global
    //     `~/.kimi-code/mcp.json`, project `<cwd>/.kimi-code/mcp.json`.
    //   · NO env markers reach subprocesses (probe: `env | grep ^KIMI` is empty
    //     inside its own shell tool), hence the empty envMarkers and the binary
    //     probe below — the installer lives in ~/.kimi-code/bin, a dir only
    //     interactive shells put on PATH.
    id: "kimi",
    label: "Kimi Code",
    glyph: "K",
    support: { tier: "official", unstableSurface: true },
    runtime: {
      bins: ["kimi"],
      fallbackBinPaths: ["~/.kimi-code/bin/kimi"],
      versionArgs: ["--version"],
    },
    configDir: { kind: "dir", path: "~/.kimi-code" },
    hooks: { mechanism: "~/.kimi-code/config.toml → [[hooks]]", managed: true },
    envMarkers: [],
    mcpHostId: "kimi",
    globalMcpPaths: {
      darwin: "~/.kimi-code/mcp.json",
      linux: "~/.kimi-code/mcp.json",
      win32: "~/.kimi-code/mcp.json",
    },
    projectMcpPath: ".kimi-code/mcp.json",
    pluginManifest: null, // Kimi has plugins, but no manifest convention we ship.
    pluginHooksDir: null, // Its hooks live in config.toml, not in a plugin dir.
    skillsDirs: [".kimi-code/skills", ".agents/skills"],
    installTarget: "kimi",
    // The one host with a VERIFIED typed form: a skill dropped in
    // ~/.agents/skills was listed and invoked this way (probe 2026-07-29, the
    // same one `COMMAND_SKILLS_HOSTS` rests on).
    invocation: {
      kind: "slash",
      template: "/skill:<name>",
      note: "probe 2026-07-29: las skills SON la superficie de comandos de Kimi Code",
    },
    structuredChoice: {
      state: "native",
      tool: "AskUserQuestion",
      ceilings: { questions: 4, options: 4 },
      sentence: "field",
      sentenceMaxChars: null,
      customAnswer: true,
      fallbackReason:
        "the call fails, or the permission mode is `auto` or the run is non-interactive (this host's own system rule forbids the call there)",
      evidence:
        "probe 2026-08-04 on kimi 0.31.1: the tool is in the default agent's list and its schema is 1-4 questions × 2-4 options with `label` + `description`; in `--prompt` it refused the call ('auto mode is active') and degraded to labeled markdown on its own, options and consequences intact",
    },
  },
] as const satisfies readonly HarnessSpec[];

/**
 * A skills directory SHARED by several hosts. It is a legitimate install
 * destination and NEVER a host: it has no runtime, nothing to invoke, and it
 * must not inflate any host count (spec 010, criterion 3).
 */
export interface SharedSkillDestination {
  id: Extract<InstallTarget, "agents">;
  label: string;
  glyph: string;
  /** The dir, as it reads to a human. */
  dir: string;
  /** Hosts that pick skills up from it — derived, so it cannot drift. */
  readBy: readonly HarnessId[];
}

/** Hosts that auto-discover skills from the open-standard `~/.agents/skills`. */
function hostsReading(dir: string): readonly HarnessId[] {
  return HARNESSES.filter((h) => h.skillsDirs.includes(dir)).map((h) => h.id);
}

export const SHARED_SKILL_DESTINATIONS: readonly SharedSkillDestination[] = [
  {
    id: "agents",
    label: "Agents (shared skills dir)",
    glyph: "A",
    dir: "~/.agents/skills",
    readBy: hostsReading(".agents/skills"),
  },
];

/** One install target per host, in catalog order. THE host set. */
export const HOST_INSTALL_TARGETS: readonly InstallTarget[] = HARNESSES.map((h) => h.installTarget);

/**
 * Hosts that write an MCP config FILE. Oz is out on purpose: it takes servers
 * through a `--mcp` launch flag, so there is nothing to write for it.
 */
export const MCP_FILE_HOSTS: readonly McpHost[] = HARNESSES.filter((h) => h.mcpHostId !== null).map(
  (h) => h.mcpHostId as McpHost,
);

/** Install targets that are shared destinations, not hosts. */
export const SHARED_INSTALL_TARGETS: readonly InstallTarget[] = SHARED_SKILL_DESTINATIONS.map(
  (d) => d.id,
);

/** The HarnessSpec owning an install target, or null for a shared destination. */
export function harnessByInstallTarget(target: InstallTarget): HarnessSpec | null {
  return HARNESSES.find((h) => h.installTarget === target) ?? null;
}

/**
 * What a verification RUN proved about this host, or null when no run ever
 * covered it. Read it instead of asserting support from the tier alone: the
 * tier is what we promise, this is what was actually checked.
 */
export function verificationFor(id: HarnessId): HarnessVerification | null {
  return HOST_VERIFICATIONS[id] ?? null;
}

/**
 * Resolves the global MCP config path template for a harness spec. Does NOT
 * expand `~` nor %LOCALAPPDATA% — expansion is the caller's job (see
 * multiroot/warp.ts resolveWarpGlobalMcpPath).
 */
export function resolveGlobalMcpRawPath(
  spec: HarnessSpec,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (!spec.globalMcpPaths) return null;
  return platform === "darwin"
    ? spec.globalMcpPaths.darwin
    : platform === "linux"
      ? spec.globalMcpPaths.linux
      : spec.globalMcpPaths.win32;
}

/** Returns the HarnessSpec for a given McpHost id, or null. */
export function harnessForMcpHost(host: McpHost): HarnessSpec | null {
  return HARNESSES.find((h) => h.mcpHostId === host) ?? null;
}

/** Returns the HarnessSpec for a given harness id, or null. */
export function harnessById(id: HarnessId): HarnessSpec | null {
  return HARNESSES.find((h) => h.id === id) ?? null;
}
