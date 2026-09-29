// Antigravity (`agy`): `permissions.deny` in ~/.gemini/antigravity-cli/settings.json.
// Read from the agy 1.2.11 binary: the path, the `permissions` key, «Add an
// allow-rule under permissions.allow in settings.json», the rule form
// `command(%s)` and «always deny for commands that start with '%s'» — rules are
// command prefixes. Whether agy checks every subcommand of a chained command is
// unverified, so nothing is pre-approved and `--mode accept-edits` is not used
// (it would accept edits anywhere): every command and edit asks the person.
// This is NOT a file `aw self install` writes; if agy refuses to start with it,
// its permissions go back to the person and the matrix records `agy_without_profile`.

import { DENIAL_CATEGORIES } from "./denials.mjs";

const denials = DENIAL_CATEGORIES.flatMap((c) =>
  [...c.prefixes, ...(c.prefixFallback ?? [])].map((p) => ({
    category: c.id,
    rule: `command(${p.join(" ")})`,
  })),
);

const permissionsOf = (files) => files[0]?.value?.permissions ?? {};

export default {
  host: "gemini",
  allowsEdit: true,
  allowsExec: true,
  denials,
  paneArgs: [],
  limitations: [
    "every command and edit asks you in the pane",
    "prefix rules cannot match --force anywhere; only its fallback prefixes are denied",
  ],
  files: () => [
    {
      path: ".gemini/antigravity-cli/settings.json",
      kind: "json",
      value: { permissions: { deny: denials.map((d) => d.rule) } },
    },
  ],
  deniedIn: (files) => permissionsOf(files).deny ?? [],
  allowedIn: (files) => permissionsOf(files).allow ?? [],
  effective: () => ({ allow: [], deny: denials.map((d) => d.rule) }),
};
