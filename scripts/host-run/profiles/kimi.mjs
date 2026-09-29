// Kimi Code: `[permission]` in $KIMI_CODE_HOME/config.toml, the file `aw self
// install` merges its [[hooks]] into, and `default_permission_mode = "manual"` so
// the run is never in auto mode (where kimi does not call AskUserQuestion).
//
// Read from the kimi 0.39.1 binary:
// - `permissionFromToml` appends `rules`, then `deny`, then `allow`; each entry
//   goes through `transformPermissionRule`, which only reshapes PLAIN OBJECTS
//   (a bare string passes through untouched) and sets `decision` from the key;
// - `PermissionRuleSchema = object({decision, scope: default "user", pattern
//   (refined by isValidPermissionPattern), reason?})`. A string entry fails it,
//   and `salvageConfigData` then drops the WHOLE `permission` section ("Ignored
//   invalid config … permission"). So every entry is an inline table;
// - a pattern is `Tool` or `Tool(<glob>)`; for Bash the glob is matched with
//   `picomatch.isMatch(args.command, glob)`, default options, over the whole
//   command string.
//
// Nothing is pre-approved by the profile (see homeDenials for what kimi approves itself). Each denial is
// written in three picomatch forms (checked with picomatch 4.0.7; kimi bundles
// 4.0.4) that match it anywhere in the command: after `&&`/`;`, across `/`, and
// across newlines (picomatch's `*` does cross `\n`). Without `dot: true`, which
// kimi does not pass, a globstar skips dot segments: the extra forms catch a
// dotted last segment (`rm -rf ./.git`, `rm -rf /tmp/.cache`), but not several
// dotted segments or `..` chains (`rm -rf /a/.b/.c/d`) — those still ask you.

import { DENIAL_CATEGORIES } from "./denials.mjs";
import { STEERING_FILES } from "./steering.mjs";

/** picomatch globs matching `text` anywhere in a command (see above for the gaps). */
export const anywhereGlobs = (text) => [
  `{**/,}*${text}*{,/**}`,
  `{**/,}*${text}*/**/.*`,
  `{**/,}*${text}*/**/.*/**`,
];

const denials = DENIAL_CATEGORIES.flatMap((c) =>
  [...c.prefixes.map((p) => p.join(" ")), ...(c.anywhere ? [c.anywhere] : [])].flatMap((text) =>
    anywhereGlobs(text).map((glob) => ({ category: c.id, rule: `Bash(${glob})` })),
  ),
);

/** The scope kimi's schema defaults to; written explicitly so no default is relied on. */
const SCOPE = "user";

const entryToml = (pattern) => `  { pattern = ${JSON.stringify(pattern)}, scope = "${SCOPE}" },`;

/**
 * Kimi's policy order (0.39.1, `createPermissionDecisionPolicies`; the first
 * answer wins): hook, …, UserConfiguredDeny, AutoModeApprove,
 * SessionApprovalHistory, UserConfiguredAsk, UserConfiguredAllow, …,
 * SensitiveFileAccessAsk, GitControlPathAccessAsk, …, DefaultToolApprove (Read,
 * Grep, Glob, ReadMediaFile, AskUserQuestion, Skill, WebSearch, FetchURL, Agent,
 * … — read from BOTH DEFAULT_APPROVE_TOOLS sets in the binary), GitCwdWriteApprove
 * (Write/Edit whose every path lies inside the git work tree of its cwd — the
 * disposable workspace, since the pane starts there), FallbackAsk.
 *
 * So this profile's deny and ask rules run before those auto-approvals:
 * - Read/ReadMediaFile/Write/Edit take path rules (`pathGlobMatch`: picomatch,
 *   nocase, no `dot`): the real HOME is denied in five forms so dotfiles and dot
 *   directories match (`/**` alone skips them). A path with three or more dotted
 *   segments below HOME is not matched and falls through — declared.
 * - Grep and Glob match their search pattern, not a path: they cannot be scoped.
 * - The workspace's steering files ask before Write/Edit (UserConfiguredAsk runs
 *   before GitCwdWriteApprove).
 */
export const homeGlobs = (home) => [
  `${home}/**`,
  `${home}/**/.*`,
  `${home}/**/.*/**`,
  `${home}/**/.*/**/.*`,
  `${home}/**/.*/**/.*/**`,
];

const homeDenials = (realHome) =>
  realHome
    ? ["Read", "ReadMediaFile", "Write", "Edit"].flatMap((tool) =>
        homeGlobs(realHome).map((glob) => `${tool}(${glob})`),
      )
    : [];

const steeringAsks = (workspace) =>
  workspace
    ? ["Write", "Edit"].flatMap((tool) =>
        STEERING_FILES.map((rel) => `${tool}(${workspace}/${rel})`),
      )
    : [];

const list = (key, patterns) =>
  patterns.length === 0 ? `${key} = []` : `${key} = [\n${patterns.map(entryToml).join("\n")}\n]`;

const permissionTable = (realHome, workspace) =>
  [
    "[permission]",
    list("deny", [...denials.map((d) => d.rule), ...homeDenials(realHome)]),
    list("ask", steeringAsks(workspace)),
    "allow = []",
  ].join("\n");

const ENTRY = /^\s*\{ pattern = ("(?:[^"\\]|\\.)*"), scope = "([\w-]+)" \},?\s*$/;

/**
 * The entries of a list key inside a [permission] table of any TOML text (the
 * profile's own, or the merged config.toml): [{pattern, scope}], or a
 * `{invalid}` marker for any entry that is not an inline table.
 */
export function permissionEntries(text, key) {
  const start = text.indexOf("[permission]");
  if (start === -1) return [];
  const table = text.slice(start).split(/\n(?=\[)/)[0];
  const open = table.indexOf(`\n${key} = [`);
  if (open === -1) return [];
  const body = table.slice(open + key.length + 5);
  const inline = body.split("\n")[0].trim();
  if (inline.startsWith("]")) return [];
  const lines = body
    .slice(0, body.indexOf("\n]"))
    .split("\n")
    .filter((l) => l.trim() !== "");
  return lines.map((l) => {
    const m = ENTRY.exec(l);
    return m ? { pattern: JSON.parse(m[1]), scope: m[2] } : { invalid: l.trim() };
  });
}

/**
 * A hand-port of kimi 0.39.1's PermissionRuleSchema for one entry after
 * `transformPermissionRule`: a table with a non-empty `Tool` or `Tool(glob)`
 * pattern and a scope from its enum. Returns the problems.
 */
export function kimiRuleProblems(entry) {
  if (entry.invalid !== undefined) return [`not an inline table: ${entry.invalid}`];
  const problems = [];
  const p = entry.pattern;
  const open = p.indexOf("(");
  if (p.trim().length === 0) problems.push("empty pattern");
  else if (open === 0) problems.push(`empty tool name in ${p}`);
  else if (open !== -1 && !p.endsWith(")")) problems.push(`missing closing paren in ${p}`);
  if (!["turn-override", "session-runtime", "project", "user"].includes(entry.scope)) {
    problems.push(`scope '${entry.scope}' is not in the schema`);
  }
  return problems;
}

const textOf = (files) =>
  files
    .filter((f) => f.path.endsWith("config.toml"))
    .map((f) => f.value)
    .join("\n");

export default {
  host: "kimi",
  allowsEdit: true,
  allowsExec: true,
  denials,
  paneArgs: [],
  limitations: [
    "every shell command asks you; kimi itself approves Write/Edit inside the git workspace and Read/Grep/Glob/Skill/AskUserQuestion elsewhere",
    "Read/Write/Edit under your real HOME are denied (dotfiles included, up to two dotted segments deep); Grep and Glob cannot be path-scoped",
    "editing the workspace's CLAUDE.md/AGENTS.md, .workflow config, .git or .kimi-code/local.toml asks you",
    "kimi's «approve for session» history runs before its ask rules: once you approve a Write/Edit for the session, a later steering-file edit may not ask again",
  ],
  files: ({ realHome, workspace } = {}) => [
    {
      path: ".kimi-code/config.toml",
      kind: "toml-top",
      value: 'default_permission_mode = "manual"',
    },
    {
      path: ".kimi-code/config.toml",
      kind: "toml-table",
      value: permissionTable(realHome, workspace),
    },
  ],
  deniedIn: (files) => permissionEntries(textOf(files), "deny").map((e) => e.pattern ?? e.invalid),
  allowedIn: (files) =>
    permissionEntries(textOf(files), "allow").map((e) => e.pattern ?? e.invalid),
  effective: ({ realHome, workspace } = {}) => ({
    mode: "manual",
    deny: [...denials.map((d) => d.rule), ...homeDenials(realHome)],
    ask: steeringAsks(workspace),
    allow: [],
  }),
};
