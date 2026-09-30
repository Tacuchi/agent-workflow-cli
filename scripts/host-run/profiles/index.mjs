// The six permission profiles, validated on load: a profile missing an AC-04
// denial never reaches a home.

import claude from "./claude-code.mjs";
import codex from "./codex.mjs";
import crush from "./crush.mjs";
import { validateProfile } from "./denials.mjs";
import gemini from "./gemini.mjs";
import kimi from "./kimi.mjs";
import opencode from "./opencode.mjs";

export const PROFILES = {
  "claude-code": claude,
  codex,
  gemini,
  opencode,
  crush,
  kimi,
};

/** Text of every file a profile writes, as `validateProfile` searches it. */
export function renderedText(files) {
  return files
    .map((f) => (typeof f.value === "string" ? f.value : JSON.stringify(f.value)))
    .join("\n");
}

/** Refuses the whole set if any profile fails AC-04. */
export function loadProfiles(
  profiles = PROFILES,
  ctx = { home: "<home>", workspace: "<workspace>", node: "node" },
) {
  const problems = Object.values(profiles).flatMap((p) => validateProfile(p, p.files(ctx)));
  if (problems.length > 0) {
    throw new Error(`permission profiles rejected:\n  ${problems.join("\n  ")}`);
  }
  return profiles;
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Objects merge key by key, arrays append what they lack, scalars from the profile win. */
export function mergeJson(base, patch) {
  if (Array.isArray(base) && Array.isArray(patch)) {
    const seen = new Set(base.map((v) => JSON.stringify(v)));
    return [...base, ...patch.filter((v) => !seen.has(JSON.stringify(v)))];
  }
  if (isPlainObject(base) && isPlainObject(patch)) {
    const out = { ...base };
    for (const [k, v] of Object.entries(patch)) out[k] = k in base ? mergeJson(base[k], v) : v;
    return out;
  }
  return patch;
}

/**
 * TOML without a parser: top-level keys go before the first table, tables at the
 * end. A key or table the file already has is a conflict, never an overwrite —
 * `self install` owns what it wrote.
 */
export function mergeToml(text, file) {
  const lines = file.value.split("\n");
  const conflicts = lines
    .map((l) => /^\s*(\[[^\]]+\]|[A-Za-z0-9_]+)\s*(=|$)/.exec(l)?.[1])
    .filter((k) => k !== undefined)
    .filter((k) =>
      k.startsWith("[")
        ? text.split("\n").some((l) => l.trim() === k)
        : file.kind === "toml-top" && new RegExp(`^\\s*${k}\\s*=`, "m").test(text),
    );
  if (conflicts.length > 0) {
    throw new Error(`profile conflicts with keys already present: ${conflicts.join(", ")}`);
  }
  if (file.kind === "toml-table") return `${text.replace(/\n*$/, "\n")}\n${file.value}\n`;
  return `${file.value}\n${text}`;
}
