// Codex: `prefix_rule(pattern=[...], decision="forbidden")` in
// $CODEX_HOME/rules/default.rules, plus a user-level permission profile in
// $CODEX_HOME/config.toml (the file `aw self install` and `aw mcp setup` leave).
//
// Read from the codex-cli 0.157.1 binary: `default.rules`, `prefix_rule(pattern=`,
// the decisions `prompt|forbidden|allow`; `PermissionProfileToml {description,
// extends, workspace_roots, filesystem, network}`, `FileSystemAccessMode` with
// read/write/deny/none, the built-ins `:read-only`/`:workspace`, the special
// paths `:tmpdir`/`:slash_tmp`, and «`sandbox_mode` and `default_permissions`
// overrides cannot both be set». The config reference
// (https://learn.chatgpt.com/docs/permissions) confirms the TOML shape and says
// profiles do not compose with `sandbox_mode` / `[sandbox_workspace_write]`: if
// sandbox_mode is set anywhere, the legacy settings win. So this profile sets
// NO sandbox_mode and uses `default_permissions = "hostrun"`, a profile that
// extends `:workspace` (the workspace writable, network off, commands run without
// asking inside it) and denies the person's real HOME (reads and writes) and
// /tmp (`:slash_tmp`; $TMPDIR is already inside the root). The shape was loaded
// by `codex features list` (config-only: a broken access value fails with
// «data did not match any variant of untagged enum FilesystemPermissionToml»);
// its enforcement is not yet exercised against a live codex run.
//
// A prefix rule cannot match a flag anywhere in the line, so `--force` is denied
// through its fallback prefixes. No allowlist is written; escalating out of the
// profile asks the person (`on-request`).

import { DENIAL_CATEGORIES } from "./denials.mjs";

const rule = (words) =>
  `prefix_rule(pattern=${JSON.stringify(words).replaceAll(",", ", ")}, decision="forbidden", justification="host-run profile: spec 062 AC-04")`;

const denials = DENIAL_CATEGORIES.flatMap((c) =>
  [...c.prefixes, ...(c.prefixFallback ?? [])].map((p) => ({ category: c.id, rule: rule(p) })),
);

/** Each rule statement of the .rules files whose decision, parsed, satisfies `keep`. */
function rulesWith(files, keep) {
  return files
    .filter((f) => f.path.endsWith(".rules"))
    .flatMap((f) => f.value.split("\n"))
    .filter((l) => /^\s*\w+_rule\s*\(/.test(l))
    .filter((l) => keep(/\bdecision\s*=\s*["'](\w+)["']/.exec(l)?.[1] ?? "allow"));
}

const TOP_LEVEL = 'approval_policy = "on-request"\ndefault_permissions = "hostrun"';

const profileTable = (realHome, siblingRoots = []) =>
  [
    "[permissions.hostrun]",
    'description = "host-run: the workspace writable, the real HOME and /tmp denied"',
    'extends = ":workspace"',
    "",
    // Network off explicitly: the binary also knows a «Workspace with network
    // access», so `:workspace` alone is not relied on. `network.enabled` is the
    // key its help text documents («set to `true` to enable network access»).
    "[permissions.hostrun.network]",
    "enabled = false",
    "",
    "[permissions.hostrun.filesystem]",
    ...(realHome ? [`${JSON.stringify(realHome)} = "deny"`] : []),
    // The other hosts' disposable roots: their copied credentials and token files.
    ...siblingRoots.map((sib) => `${JSON.stringify(sib)} = "deny"`),
    '":slash_tmp" = "deny"',
  ].join("\n");

export default {
  host: "codex",
  allowsEdit: true,
  allowsExec: true,
  denials,
  paneArgs: [],
  limitations: [
    "reads and writes of your real HOME are denied through a codex permission profile (default_permissions = hostrun); its config shape loads in codex 0.157.1 (`codex features list`, config-only) but the enforcement is unverified against a live codex run — until then, treat codex as able to read any file your user can",
    "prefix rules cannot match --force anywhere; only its fallback prefixes are denied",
    "the other hosts' disposable roots (copied credentials, token files) are denied to it",
  ],
  files: ({ realHome, siblingRoots } = {}) => [
    {
      path: ".codex/rules/default.rules",
      kind: "text",
      value: `# host-run profile (spec 062 AC-04)\n${denials.map((d) => d.rule).join("\n")}\n`,
    },
    { path: ".codex/config.toml", kind: "toml-top", value: TOP_LEVEL },
    { path: ".codex/config.toml", kind: "toml-table", value: profileTable(realHome, siblingRoots) },
  ],
  deniedIn: (files) => rulesWith(files, (d) => d === "forbidden"),
  // Anything that is not forbidden or prompt runs without asking: a shell pre-approval.
  allowedIn: (files) =>
    rulesWith(files, (d) => d !== "forbidden" && d !== "prompt").map((r) => `bash:${r}`),
  effective: ({ realHome, siblingRoots = [] } = {}) => ({
    permissions: `profile hostrun: extends :workspace; network.enabled = false; deny ${realHome ?? "<real HOME>"}, ${siblingRoots.length} sibling root(s) and :slash_tmp`,
    approval: "on-request",
    deny: denials.map((d) => d.rule),
  }),
};
