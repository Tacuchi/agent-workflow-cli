// Claude Code: `permissions.allow` / `ask` / `deny` in ~/.claude/settings.json,
// the same file `aw self install` merges its hooks into. Precedence is deny >
// ask > allow; `Bash(<prefix>:*)` is the prefix form and `*` matches anywhere in
// the command; `//path` in an Edit or Read rule is an absolute path. Only Edit
// and Read take a path: claude 2.1.285's rule validator maps Write, NotebookEdit
// and MultiEdit to Edit, and Glob to Read («… is not matched by file permission
// checks — only Edit(path) rules are … (Edit rules cover all file-editing
// tools)», binary strings), so no Write(path) rule is written. Claude Code
// documents that its prefix rules are aware of shell operators: `Bash(safe-cmd:*)`
// does not allow `safe-cmd && other-cmd`.
// Source: https://docs.anthropic.com/en/docs/claude-code/iam#tool-specific-permission-rules
// (unverified against the 2.1.284 binary, whose JS is not readable as strings).
//
// Pre-approved, per the orchestrator's middle path: edits under the workspace's
// real path, the Workline MCP tools (a read-only server on an unreachable DSN,
// so the PreToolUse step reaches the SQL guard hook), the exact `pwd`, and the
// Workline invocations the scenario makes (CLAUDE_SHELL_ALLOW). Any of those
// carrying --hub, --root or --approval, and `doctor apply`, ASK.

import { PROBE_MCP } from "../scenario.mjs";
import { CLAUDE_SHELL_ALLOW, DENIAL_CATEGORIES } from "./denials.mjs";
import { STEERING_FILES } from "./steering.mjs";

const denials = DENIAL_CATEGORIES.flatMap((c) => [
  ...c.prefixes.map((p) => ({ category: c.id, rule: `Bash(${p.join(" ")}:*)` })),
  ...(c.anywhere ? [{ category: c.id, rule: `Bash(*${c.anywhere}*)` }] : []),
]);

/**
 * Pre-approved Workline calls that reach outside the workspace or approve
 * effects. `--root` itself is not asked: the wrappers pin it on every
 * context-plan and flow start to the bundle installed in this disposable home
 * (run 3 asked on each). A `--root` naming the real HOME, `~`, `$HOME`, a parent
 * directory or another host's root still asks.
 */
const cliAsk = (realHome, siblingRoots = []) =>
  ["aw", "agent-workflow"].flatMap((cli) => [
    `Bash(${cli} *--hub*)`,
    `Bash(${cli} *--approval*)`,
    `Bash(${cli} doctor apply:*)`,
    ...["~", "$HOME", "..", ...(realHome ? [realHome] : []), ...siblingRoots].flatMap((p) => [
      `Bash(${cli} *--root ${p}*)`,
      `Bash(${cli} *--root "${p}*)`,
      `Bash(${cli} *--root=${p}*)`,
    ]),
  ]);

const askFor = (workspace, realHome, siblingRoots) => [
  ...cliAsk(realHome, siblingRoots),
  ...STEERING_FILES.map((rel) => `Edit(/${workspace}/${rel})`),
];

/**
 * Claude's read-only tools run without asking (Read rules also cover Grep/Glob):
 * nothing under the person's real HOME is readable — its credentials live there.
 */
const readDenials = ({ realHome, root, siblingRoots = [] }) => [
  ...(realHome ? [`Read(/${realHome}/**)`] : []),
  // The other hosts' disposable roots (their copied credentials, their token
  // files) and this root's own token file and launcher.
  ...siblingRoots.map((sib) => `Read(/${sib}/**)`),
  ...(root ? [`Read(/${root}/secrets/**)`, `Read(/${root}/bin/launch-*)`] : []),
];

/** `workspace` must be a real path (macOS: /private/var, not /var); run.mjs resolves it. */
const allowFor = (workspace) => [
  `Edit(/${workspace}/**)`,
  ...CLAUDE_SHELL_ALLOW,
  `mcp__${PROBE_MCP.name}__execute_sql`,
  `mcp__${PROBE_MCP.name}__search_objects`,
];

const permissionsOf = (files) =>
  files.find((f) => f.path === ".claude/settings.json")?.value?.permissions ?? {};

export default {
  host: "claude-code",
  allowsEdit: true,
  allowsExec: true,
  denials,
  paneArgs: [],
  limitations: [
    "only the scenario's Workline calls are pre-approved; every other command asks you in the pane",
    "a Workline call with --hub or --approval, `doctor apply`, or a --root naming your real HOME, ~, $HOME, a parent dir or another host's root, asks you; --root at the disposable bundle does not",
    "a Workline call piped into another program (`aw flow … | python3 …`) asks you: claude matches every command of a pipeline, and the second one is arbitrary code the run cannot pre-approve",
    "editing the workspace's CLAUDE.md/AGENTS.md, Workline marker, .git or host configs asks you",
    "nothing under your real HOME can be read",
    "the other hosts' disposable roots (copied credentials, token files) are denied to it",
    "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 is set: per https://code.claude.com/docs/en/env-vars it strips Anthropic and other recognized credentials (the token included) from claude's Bash tool, hooks and stdio MCP servers; their own children inherit the scrubbed environment; whether 2.1.284 strips CLAUDE_CODE_OAUTH_TOKEN is unverified live",
  ],
  files: ({ workspace, realHome, root, siblingRoots }) => [
    {
      path: ".claude/settings.json",
      kind: "json",
      value: {
        permissions: {
          allow: allowFor(workspace),
          ask: askFor(workspace, realHome, siblingRoots),
          deny: [...denials.map((d) => d.rule), ...readDenials({ realHome, root, siblingRoots })],
        },
      },
    },
    // First-run state in the disposable home's ~/.claude.json, merged with what
    // `aw mcp setup` registers there. Keys from the 2.1.285 binary: the
    // onboarding (theme picker) is skipped once `hasCompletedOnboarding` is
    // true; the trust dialog once `projects[<dir>].hasTrustDialogAccepted` is
    // («… or set projects[<dir>].hasTrustDialogAccepted: true in <file>»). The
    // bypass-permissions acceptance is never set.
    {
      path: ".claude.json",
      kind: "json",
      value: {
        hasCompletedOnboarding: true,
        theme: "dark",
        ...(workspace
          ? {
              projects: {
                [workspace]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true },
              },
            }
          : {}),
      },
    },
  ],
  deniedIn: (files) => permissionsOf(files).deny ?? [],
  // Every rule, whatever its decision (the validator checks their forms).
  rulesIn: (files) => {
    const p = permissionsOf(files);
    return [...(p.allow ?? []), ...(p.ask ?? []), ...(p.deny ?? [])];
  },
  // An `ask` entry is not a pre-approval; only `allow` is.
  allowedIn: (files) => permissionsOf(files).allow ?? [],
  effective: ({ workspace, realHome, root, siblingRoots }) => ({
    allow: allowFor(workspace),
    ask: askFor(workspace, realHome, siblingRoots),
    deny: [...denials.map((d) => d.rule), ...readDenials({ realHome, root, siblingRoots })],
  }),
};
