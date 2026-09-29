// Crush: a PreToolUse hook on `^bash$` in the crush.json `aw` writes, which
// DENIES the AC-04 commands and pre-approves nothing; `permissions.allowed_tools`
// lists only the Workline MCP tools. Hook contract read from the crush v0.96.1
// binary's embedded docs: `{"matcher", "command", "timeout"}`, the command in
// $CRUSH_TOOL_INPUT_COMMAND, `exit 2` blocks the call, and a deny from any hook
// wins. The hook sees one string, so no command can be proven confined: every
// bash call, read and edit (view/edit/write/multiedit are not scoped) asks the
// person. The MCP tool name form `mcp_<server>_<tool>` is unverified.

import { PROBE_MCP } from "../scenario.mjs";
import { DENIAL_CATEGORIES } from "./denials.mjs";

export const GUARD_PATH = ".host-run/deny-guard.mjs";

const denials = DENIAL_CATEGORIES.flatMap((c) => [
  ...c.prefixes.map((p) => ({ category: c.id, rule: JSON.stringify(p) })),
  ...(c.anywhere ? [{ category: c.id, rule: JSON.stringify(c.anywhere) }] : []),
]);

const prefixes = DENIAL_CATEGORIES.flatMap((c) => c.prefixes.map((p) => [c.id, p]));
const anywhere = DENIAL_CATEGORIES.filter((c) => c.anywhere).map((c) => [c.id, c.anywhere]);

/**
 * A self-contained guard: copied into the disposable home, imports nothing.
 * Segments split on every shell separator INCLUDING newlines and CRs, and any
 * segment matching a denial blocks the whole call. It never answers "allow".
 */
export function guardSource() {
  return `#!/usr/bin/env node
// host-run deny guard for crush (spec 062 AC-04). Generated; deleted with the home.
const DENY_PREFIXES = ${JSON.stringify(prefixes)};
const DENY_ANYWHERE = ${JSON.stringify(anywhere)};
const line = process.env.CRUSH_TOOL_INPUT_COMMAND ?? "";
const segments = line
  .split(/[;&|\\n\\r(){}\`]+|\\$\\(/)
  .map((s) => s.trim().split(/\\s+/).filter(Boolean));
const starts = (words, prefix) => prefix.every((w, i) => words[i] === w);
for (const words of segments) {
  const hit =
    DENY_PREFIXES.find(([, p]) => starts(words, p)) ??
    DENY_ANYWHERE.find(([, flag]) => words.some((w) => w === flag || w.startsWith(flag + "=")));
  if (hit) {
    process.stderr.write("host-run profile denies '" + hit[0] + "': " + words.join(" ") + "\\n");
    process.exit(2);
  }
}
process.exit(0);
`;
}

/** The JSON array a generated guard assigns to `name`. */
function guardList(files, name) {
  const source = files.find((f) => f.path === GUARD_PATH)?.value ?? "";
  const line = source.split("\n").find((l) => l.startsWith(`const ${name} = `));
  return line ? JSON.parse(line.slice(`const ${name} = `.length, -1)) : [];
}

const allowedTools = [`mcp_${PROBE_MCP.name}_execute_sql`, `mcp_${PROBE_MCP.name}_search_objects`];

export default {
  host: "crush",
  allowsEdit: true,
  allowsExec: true,
  denials,
  paneArgs: [],
  limitations: [
    "every bash call, read and edit asks you in the pane (crush's tools are not path-scoped)",
    "reads cannot be path-scoped here: this host may read the other hosts' disposable roots (their copied credentials) unasked; a token file there lives only milliseconds, between its write and its wrapper's rm -f before exec",
  ],
  files: ({ home, node }) => [
    { path: GUARD_PATH, kind: "text", mode: 0o700, value: guardSource() },
    {
      path: ".config/crush/crush.json",
      kind: "json",
      value: {
        permissions: { allowed_tools: allowedTools },
        hooks: {
          PreToolUse: [
            { matcher: "^bash$", command: `${node} ${home}/${GUARD_PATH}`, timeout: 10 },
          ],
        },
      },
    },
  ],
  deniedIn: (files) => [
    ...guardList(files, "DENY_PREFIXES").map(([, p]) => JSON.stringify(p)),
    ...guardList(files, "DENY_ANYWHERE").map(([, flag]) => JSON.stringify(flag)),
  ],
  allowedIn: (files) => {
    const tools = files.find((f) => f.kind === "json")?.value?.permissions?.allowed_tools ?? [];
    const source = files.find((f) => f.path === GUARD_PATH)?.value ?? "";
    return [
      ...tools.map((t) => (t === "bash" ? "bash" : `tool:${t}`)),
      // The guard may only deny: any output channel or a decision anywhere in it is
      // read as a possible pre-approval, whatever its spelling.
      ...(/process\.stdout|console\.|\bdecision\b/.test(source) ? ["bash"] : []),
    ];
  },
  effective: () => ({
    allowed_tools: allowedTools,
    guard_deny: denials.map((d) => `${d.category} ${d.rule}`),
  }),
};
