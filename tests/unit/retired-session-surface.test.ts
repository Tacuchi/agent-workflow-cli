// Spec 066, AC-12 y AC-16: en 31.0.0 ningún comando, flag, hook ni texto de
// ayuda vigente nombra sesiones, `--code`, `aw reset` o `sessionNNN`. El barrido
// cubre el registro de comandos, su ayuda y el bundle `skills/w`.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ALL_COMMANDS } from "../../src/cli/commands/index.js";

const RETIRED_COMMANDS = [
  "sessions",
  "session-create",
  "session-load",
  "session-pause",
  "session-close",
  "session-artifacts",
  "history",
  "history-update",
  "checkpoint-read",
  "checkpoint-write",
  "claims",
  "reset",
  "export-diagrams",
  "export-manuals",
  "export-reports",
  "release-data",
  "hub-commit",
  "worktree",
];

/** What the session model was called on any surface; the host's own SessionStart event stays. */
const RETIRED_TEXT: readonly [string, RegExp][] = [
  ["--code", /--code\b/],
  ["--session", /--session\b/],
  ["aw reset", /\baw reset\b|\/w:reset\b/],
  ["sessionNNN", /\bsession\d{3}\b/],
  ["sesión", /\bsesi[oó]n(es)?\b/i],
  ["session", /\bsessions?\b(?!Start)/i],
  ["HISTORY.md", /HISTORY\.md/],
  ["CHECKPOINT", /\bCHECKPOINT\b/],
  [
    "hook de compactación",
    /\b(PreCompact|PostCompact|SessionEnd|pre-compact|post-compact|session-end)\b/,
  ],
  ["claims", /claims\.jsonl|\baw claims\b/],
];

const offenders = (label: string, text: string): string[] =>
  RETIRED_TEXT.filter(([, pattern]) => pattern.test(text)).map(([name]) => `${label}: ${name}`);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

describe("la superficie de 31.0.0 ya no expone sesiones", () => {
  it("el registro no tiene ningún comando retirado", () => {
    const names = ALL_COMMANDS.map((command) => command.name);
    expect(names.filter((name) => RETIRED_COMMANDS.includes(name))).toEqual([]);
  });

  it("ningún flag, ayuda ni acción vigente nombra el modelo de sesiones", () => {
    const found = ALL_COMMANDS.flatMap((command) =>
      offenders(command.name, JSON.stringify({ flags: command.flags, help: command.help })),
    );
    expect(found).toEqual([]);
  });

  it("el bundle skills/w no nombra sesiones, --code, reset ni hooks retirados", () => {
    const root = resolve("skills/w");
    const found = files(root)
      .filter((path) => /\.(md|json|toml)$/.test(path))
      .flatMap((path) => offenders(relative(root, path), readFileSync(path, "utf8")));
    expect(found).toEqual([]);
  });

  it("la plantilla de hooks sólo instala los eventos vigentes", () => {
    const template = JSON.parse(
      readFileSync(resolve("skills/w/hooks/hooks.template.json"), "utf8"),
    );
    expect(Object.keys(template.hooks ?? template).sort()).toEqual(["SessionStart"]);
  });
});
