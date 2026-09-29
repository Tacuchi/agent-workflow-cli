// OpenCode: `permission` in $XDG_CONFIG_HOME/opencode/opencode.json, the file
// `aw mcp setup` writes (src/application/mcp-host-paths.ts). `bash` patterns are
// globs over the command and the LAST matching rule wins, so the catch-all goes
// first (opencode.ai/docs/permissions; unverified against 1.18.30).
//
// Nothing is pre-approved: whether opencode checks every subcommand of a chained
// command is unverified, and its `edit` permission is not scoped to a path, so
// every command and every edit asks the person.

import { DENIAL_CATEGORIES } from "./denials.mjs";

const denials = DENIAL_CATEGORIES.flatMap((c) => [
  ...c.prefixes.map((p) => ({ category: c.id, rule: `${p.join(" ")}*` })),
  ...(c.anywhere ? [{ category: c.id, rule: `*${c.anywhere}*` }] : []),
]);

const bash = { "*": "ask", ...Object.fromEntries(denials.map((d) => [d.rule, "deny"])) };

const permissionOf = (files) => files[0]?.value?.permission ?? {};
const bashWith = (files, decision) =>
  Object.entries(permissionOf(files).bash ?? {})
    .filter(([, v]) => v === decision)
    .map(([k]) => k);

export default {
  host: "opencode",
  allowsEdit: true,
  allowsExec: true,
  denials,
  paneArgs: [],
  limitations: ["every shell command and every edit asks you in the pane"],
  files: () => [
    {
      path: ".config/opencode/opencode.json",
      kind: "json",
      value: { permission: { edit: "ask", bash } },
    },
  ],
  deniedIn: (files) => bashWith(files, "deny"),
  // Prefixed so the validator reads them as shell rules.
  allowedIn: (files) => [
    ...bashWith(files, "allow").map((k) => `bash:${k}`),
    ...(permissionOf(files).edit === "allow" ? ["edit"] : []),
  ],
  effective: () => ({ edit: "ask", bash }),
};
