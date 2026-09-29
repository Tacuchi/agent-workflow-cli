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
    "reads cannot be path-scoped here: this host may read the other hosts' disposable roots (their copied credentials) unasked; a token file there lives only milliseconds, between its write and its wrapper's rm -f before exec",
  ],
  // With a GEMINI_API_KEY given, agy is pointed at the Gemini API as its own
  // changelog says (`modelProvider: "gemini"`); without one it keeps its sign-in.
  files: ({ tokenPresent = false } = {}) => [
    {
      path: ".gemini/antigravity-cli/settings.json",
      kind: "json",
      value: {
        ...(tokenPresent ? { modelProvider: "gemini" } : {}),
        permissions: { deny: denials.map((d) => d.rule) },
      },
    },
  ],
  deniedIn: (files) => permissionsOf(files).deny ?? [],
  allowedIn: (files) => permissionsOf(files).allow ?? [],
  effective: ({ tokenPresent = false } = {}) => ({
    model_provider: tokenPresent ? "gemini (Gemini API key, not your sign-in)" : "your sign-in",
    allow: [],
    deny: denials.map((d) => d.rule),
  }),
};
