// What every profile denies, host-neutral, and what it may pre-approve
// (SHELL_PREAPPROVAL below): the person in the pane stays the last boundary.
//
// Denied (spec 062, AC-04), explicitly, in every profile: each
// category lists the command prefixes it covers, as argv words. Pattern rules
// are not a security boundary on their own; the workspaces have no remote.
//
// `validateProfile` reads each profile's OWN files back (`deniedIn` /
// `allowedIn`) and checks every denial sits under a deny decision there.

export const DENIAL_CATEGORIES = [
  {
    id: "push",
    prefixes: [
      ["git", "push"],
      // `aw git-flow` promotes branches, which is a push by another name.
      ["aw", "git-flow"],
      ["agent-workflow", "git-flow"],
    ],
  },
  { id: "tag", prefixes: [["git", "tag"]] },
  {
    id: "publish",
    prefixes: [
      ["npm", "publish"],
      ["pnpm", "publish"],
      ["yarn", "publish"],
    ],
  },
  {
    id: "global-install",
    prefixes: [
      ["npm", "install", "-g"],
      ["npm", "install", "--global"],
      ["npm", "i", "-g"],
      ["pnpm", "add", "-g"],
      ["yarn", "global", "add"],
      // `aw self update` installs the published CLI globally through npm.
      ["aw", "self", "update"],
      ["agent-workflow", "self", "update"],
    ],
  },
  // --force is a flag, not a prefix: hosts that can match anywhere use `anywhere`;
  // prefix-only rule systems (codex, agy) fall back to the forms that matter here.
  {
    id: "force",
    anywhere: "--force",
    prefixes: [],
    prefixFallback: [
      ["git", "push", "--force"],
      ["git", "clean", "--force"],
      ["git", "add", "--force"],
      ["git", "branch", "--force"],
      ["npm", "install", "--force"],
      ["npm", "i", "--force"],
      ["rm", "--force"],
    ],
  },
  {
    id: "rm-rf",
    prefixes: [
      ["rm", "-rf"],
      ["rm", "-fr"],
    ],
  },
  { id: "release-create", prefixes: [["gh", "release", "create"]] },
  { id: "pr-create", prefixes: [["gh", "pr", "create"]] },
  { id: "repo-create", prefixes: [["gh", "repo", "create"]] },
  { id: "remote-add", prefixes: [["git", "remote", "add"]] },
  {
    id: "version-change",
    prefixes: [
      ["npm", "version"],
      ["pnpm", "version"],
      ["yarn", "version"],
    ],
  },
];

export const DENIAL_IDS = DENIAL_CATEGORIES.map((c) => c.id);

/**
 * Pre-approval rule (plan 085 review): a command or tool is pre-approved only
 * when it is provably confined to the disposable root. No host's shell matcher
 * is: kimi globs the whole command string (`&&`, `;` and newlines pass), crush's
 * hook sees one string, and claude/opencode/agy splitting of chained commands is
 * unverified. So no profile pre-approves a shell command — every command asks
 * the person in the pane, except under codex's OS sandbox and the exact
 * Workline invocations claude may carry (below) — and the explicit AC-04
 * denials stay as defense in depth.
 */
const SHELL_PREAPPROVAL = /^(Bash|bash|command)(\(|:|$)|^\*$/;

/**
 * The orchestrator's middle path (AC-03/AC-04, narrowed by decision): Claude
 * Code documents that its prefix rules know shell operators — `Bash(x:*)` does
 * not allow `x && y` — so ONLY the claude profile pre-approves the Workline
 * invocations the scenario makes (the 28.0.0 quick journey, /w:doctor,
 * /w:recall, /w:resume and the checkpoint pair), under both CLI names. Anything
 * acting on another workspace, globally or with an approval digest goes to its
 * `ask` list instead (see claude-code.mjs).
 */
export const WORKLINE_INVOCATIONS = [
  ["flow", "start"],
  ["flow", "advance"],
  ["flow", "submit"],
  ["flow", "prove"],
  ["status"],
  ["session-artifacts"],
  ["sources"],
  ["context-plan"],
  ["doctor"],
  ["host-memory"],
  ["resume"],
  ["checkpoint-write"],
  ["checkpoint-read"],
];

export const CLAUDE_SHELL_ALLOW = [
  "Bash(pwd)",
  ...["aw", "agent-workflow"].flatMap((cli) =>
    WORKLINE_INVOCATIONS.map((words) => `Bash(${cli} ${words.join(" ")}:*)`),
  ),
];

/** Shell pre-approvals each host may carry; nothing broader passes the validator. */
const SHELL_ALLOWED_BY_HOST = { "claude-code": new Set(CLAUDE_SHELL_ALLOW) };

/**
 * Checks a profile against AC-04 over the files it really writes. Returns the
 * problems; empty means valid. «Allows edit/exec» means neither is denied: what
 * is not pre-approved asks the person, it is never refused.
 */
export function validateProfile(profile, files) {
  const denied = new Set(profile.deniedIn(files));
  const allowed = new Set(profile.allowedIn(files));
  const problems = DENIAL_IDS.flatMap((id) => denialProblems(profile, id, denied, allowed));
  for (const rule of allowed) {
    if (SHELL_PREAPPROVAL.test(rule) && !SHELL_ALLOWED_BY_HOST[profile.host]?.has(rule)) {
      problems.push(`${profile.host}: pre-approves shell commands ('${rule}')`);
    }
  }
  // claude matches file rules only as Edit(path) and Read(path); any other file
  // tool with a path is ignored, with a warning, by 2.1.285.
  if (profile.host === "claude-code") {
    const rules = [...(profile.rulesIn?.(files) ?? [...denied, ...allowed])];
    for (const rule of rules.filter((r) => /^(Write|NotebookEdit|MultiEdit|Glob)\(/.test(r)))
      problems.push(
        `${profile.host}: '${rule}' is not matched by claude's file checks (use Edit/Read)`,
      );
  }
  if (profile.allowsEdit !== true) problems.push(`${profile.host}: does not allow editing`);
  if (profile.allowsExec !== true) problems.push(`${profile.host}: does not allow executing`);
  return problems;
}

function denialProblems(profile, id, denied, allowed) {
  const rules = profile.denials.filter((d) => d.category === id);
  if (rules.length === 0) return [`${profile.host}: no denial for '${id}'`];
  return rules.flatMap((r) => [
    ...(denied.has(r.rule)
      ? []
      : [`${profile.host}: denial '${r.rule}' (${id}) is not under a deny decision`]),
    ...(allowed.has(r.rule) ? [`${profile.host}: '${r.rule}' is also allowed`] : []),
  ]);
}
