// Claude Code: `permissions.allow` / `ask` / `deny` in ~/.claude/settings.json,
// the same file `aw self install` merges its hooks into. Precedence is deny >
// ask > allow; `Bash(<prefix>:*)` is the prefix form and `*` matches anywhere in
// the command; `//path` in an Edit/Write rule is an absolute path. Claude Code
// documents that its prefix rules are aware of shell operators: `Bash(safe-cmd:*)`
// does not allow `safe-cmd && other-cmd`.
// Source: https://docs.anthropic.com/en/docs/claude-code/iam#tool-specific-permission-rules
// (unverified against the 2.1.284 binary, whose JS is not readable as strings).
//
// Pre-approved, per the orchestrator's middle path: edits under the workspace's
// real path, the Workline MCP tools (a read-only server on an unreachable DSN,
// so the PreToolUse step reaches the SQL guard hook), the exact `pwd`, and the
// Workline invocations the scenario makes (CLAUDE_SHELL_ALLOW). Any of those
// carrying --workspace, --root or --approval, and `doctor apply`, ASK.

import { PROBE_MCP } from "../scenario.mjs";
import { CLAUDE_SHELL_ALLOW, DENIAL_CATEGORIES } from "./denials.mjs";
import { STEERING_FILES } from "./steering.mjs";

const denials = DENIAL_CATEGORIES.flatMap((c) => [
  ...c.prefixes.map((p) => ({ category: c.id, rule: `Bash(${p.join(" ")}:*)` })),
  ...(c.anywhere ? [{ category: c.id, rule: `Bash(*${c.anywhere}*)` }] : []),
]);

/** Pre-approved Workline calls that reach outside the workspace or approve effects. */
const cliAsk = ["aw", "agent-workflow"].flatMap((cli) => [
  `Bash(${cli} *--workspace*)`,
  `Bash(${cli} *--root*)`,
  `Bash(${cli} *--approval*)`,
  `Bash(${cli} doctor apply:*)`,
]);

const askFor = (workspace) => [
  ...cliAsk,
  ...STEERING_FILES.flatMap((rel) => [`Edit(/${workspace}/${rel})`, `Write(/${workspace}/${rel})`]),
];

/**
 * Claude's read-only tools run without asking (Read rules also cover Grep/Glob):
 * nothing under the person's real HOME is readable — its credentials live there.
 */
const readDenials = (realHome) => (realHome ? [`Read(/${realHome}/**)`] : []);

/** `workspace` must be a real path (macOS: /private/var, not /var); run.mjs resolves it. */
const allowFor = (workspace) => [
  `Edit(/${workspace}/**)`,
  `Write(/${workspace}/**)`,
  ...CLAUDE_SHELL_ALLOW,
  `mcp__${PROBE_MCP.name}__execute_sql`,
  `mcp__${PROBE_MCP.name}__search_objects`,
];

const permissionsOf = (files) => files[0]?.value?.permissions ?? {};

export default {
  host: "claude-code",
  allowsEdit: true,
  allowsExec: true,
  denials,
  paneArgs: [],
  limitations: [
    "only the scenario's Workline calls are pre-approved; every other command asks you in the pane",
    "a Workline call with --workspace, --root or --approval, or `doctor apply`, asks you",
    "editing the workspace's CLAUDE.md/AGENTS.md, Workline marker, .git or host configs asks you",
    "nothing under your real HOME can be read",
  ],
  files: ({ workspace, realHome }) => [
    {
      path: ".claude/settings.json",
      kind: "json",
      value: {
        permissions: {
          allow: allowFor(workspace),
          ask: askFor(workspace),
          deny: [...denials.map((d) => d.rule), ...readDenials(realHome)],
        },
      },
    },
  ],
  deniedIn: (files) => permissionsOf(files).deny ?? [],
  // An `ask` entry is not a pre-approval; only `allow` is.
  allowedIn: (files) => permissionsOf(files).allow ?? [],
  effective: ({ workspace, realHome }) => ({
    allow: allowFor(workspace),
    ask: askFor(workspace),
    deny: [...denials.map((d) => d.rule), ...readDenials(realHome)],
  }),
};
