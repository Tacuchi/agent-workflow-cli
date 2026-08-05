// Kimi Code's hook dialect: the transformation and the managed-block surgery.
//
// The two things that must hold no matter what: nothing the user wrote in their
// config.toml is ever touched, and anything Workline cannot express in Kimi's
// dialect is REPORTED rather than silently dropped.

import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { describe, expect, it } from "vitest";
import {
  MANAGED_BLOCK_BEGIN,
  MANAGED_BLOCK_END,
  auditHooksSection,
  hooksTemplateToToml,
  kimiHookEntryDefect,
  renderManagedHooksBlock,
  stripOurHookEntries,
  upsertManagedHooksBlock,
} from "../../src/application/self/hooks-toml.js";
import type { HooksTemplate } from "../../src/application/self/install-hooks.js";

const TEMPLATE: HooksTemplate = {
  hooks: {
    SessionStart: [
      {
        matcher: "startup|resume|clear",
        hooks: [{ type: "command", command: "agent-workflow self namespace", timeout: 5 }],
      },
    ],
    PreToolUse: [
      {
        matcher: "Edit|Write",
        hooks: [{ type: "command", command: "agent-workflow hook branch-check", timeout: 15 }],
      },
      {
        matcher: "Bash",
        hooks: [{ type: "command", command: "agent-workflow hook git-commit-advisor" }],
      },
    ],
    PostCompact: [
      {
        matcher: "",
        hooks: [
          { type: "command", command: "agent-workflow resume-summary", timeout: 10 },
          { type: "prompt", prompt: "Contexto compactado…" },
        ],
      },
    ],
  },
};

describe("hooksTemplateToToml", () => {
  it("aplana cada hook de comando en una entrada [[hooks]]", () => {
    const { entries } = hooksTemplateToToml(TEMPLATE);
    expect(entries.map((e) => e.event)).toEqual([
      "SessionStart",
      "PreToolUse",
      "PreToolUse",
      "PostCompact",
    ]);
    expect(entries[0]?.command).toBe("agent-workflow self namespace");
    expect(entries[0]?.timeout).toBe(5);
  });

  it("un hook de tipo prompt NO se puede expresar: se salta y se reporta", () => {
    const { entries, skipped } = hooksTemplateToToml(TEMPLATE);
    expect(entries.some((e) => e.command === undefined)).toBe(false);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.event).toBe("PostCompact");
    expect(skipped[0]?.reason).toMatch(/prompt/);
  });

  it("el matcher viaja SOLO donde su valor es el nombre de la herramienta", () => {
    const { entries } = hooksTemplateToToml(TEMPLATE);
    const preTool = entries.filter((e) => e.event === "PreToolUse");
    expect(preTool.map((e) => e.matcher)).toEqual(["Edit|Write", "Bash"]);
    // SessionStart matchea contra el `source` de la sesión, cuyo vocabulario no
    // es el nuestro: llevar "startup|resume|clear" daría un regex que nunca
    // matchea y un hook que jamás dispara. Ausente = siempre, que es lo que ese
    // matcher expresa en Claude.
    expect(entries.find((e) => e.event === "SessionStart")?.matcher).toBeUndefined();
  });

  it("descartar el matcher es una DEGRADACIÓN declarada, no un descarte silencioso", () => {
    const { degraded, skipped } = hooksTemplateToToml(TEMPLATE);
    // Un solo evento pierde su matcher: SessionStart. PreToolUse lo conserva y
    // PostCompact no traía ninguno, así que no pierden nada.
    expect(degraded.map((d) => d.event)).toEqual(["SessionStart"]);
    expect(degraded[0]?.reason).toContain("startup|resume|clear");
    // Y no se confunde con un omitido: el hook de SessionStart SÍ se instala.
    expect(skipped.map((s) => s.event)).toEqual(["PostCompact"]);
  });

  it("un grupo sin matcher no degrada nada: no hay nada que perder", () => {
    const { degraded } = hooksTemplateToToml({
      hooks: { SessionEnd: [{ matcher: "", hooks: [{ type: "command", command: "x" }] }] },
    });
    expect(degraded).toEqual([]);
  });

  it("el timeout se acota al rango que acepta el esquema (1..600 s)", () => {
    const { entries } = hooksTemplateToToml({
      hooks: {
        SessionEnd: [
          { matcher: "", hooks: [{ type: "command", command: "x", timeout: 100000 }] },
          { matcher: "", hooks: [{ type: "command", command: "y", timeout: 0 }] },
        ],
      },
    });
    expect(entries[0]?.timeout).toBe(600);
    expect(entries[1]?.timeout).toBe(1);
  });
});

describe("bloque gestionado en config.toml", () => {
  const USER_CONFIG = [
    'default_model = "kimi-code/k3"',
    "",
    '[providers."managed:kimi-code"]',
    'type = "oauth"',
    "",
    "[[hooks]]",
    'event = "SessionEnd"',
    'command = "my-own-script.sh"',
    "",
  ].join("\n");

  it("append: deja intacto todo lo del usuario, incluidos SUS hooks", () => {
    const { entries } = hooksTemplateToToml(TEMPLATE);
    const { text: out } = upsertManagedHooksBlock(USER_CONFIG, entries);
    expect(out.startsWith(USER_CONFIG.trimEnd())).toBe(true);
    expect(out).toContain('command = "my-own-script.sh"');
    expect(out).toContain(MANAGED_BLOCK_BEGIN);
    expect(out).toContain(MANAGED_BLOCK_END);
  });

  it("round-trip: instalar y desinstalar devuelve el archivo byte a byte", () => {
    const { entries } = hooksTemplateToToml(TEMPLATE);
    const { text: installed } = upsertManagedHooksBlock(USER_CONFIG, entries);
    const { text, removed } = stripOurHookEntries(installed);
    expect(removed).toBe(entries.length);
    expect(text).toBe(USER_CONFIG);
  });

  it("reinstalar es idempotente: no acumula bloques ni líneas en blanco", () => {
    const { entries } = hooksTemplateToToml(TEMPLATE);
    const { text: once } = upsertManagedHooksBlock(USER_CONFIG, entries);
    const { text: twice } = upsertManagedHooksBlock(once, entries);
    expect(twice).toBe(once);
    expect(twice.split(MANAGED_BLOCK_BEGIN)).toHaveLength(2);
  });

  it("sin hooks nuestros, el barrido no toca nada", () => {
    const { text, removed } = stripOurHookEntries(USER_CONFIG);
    expect(removed).toBe(0);
    expect(text).toBe(USER_CONFIG);
  });

  it("archivo vacío: el bloque es todo el contenido", () => {
    const { entries } = hooksTemplateToToml(TEMPLATE);
    const { text: out } = upsertManagedHooksBlock("", entries);
    expect(out).toBe(renderManagedHooksBlock(entries));
  });

  // LA PROPIEDAD ES POR DATO, NO POR COMENTARIO. Kimi reescribe su propio
  // config.toml (login, quitar un provider…) y borra TODOS los comentarios,
  // conservando el array `hooks`. Si el marcador fuera la identidad, a partir de
  // esa reescritura nuestros hooks quedarían sin forma de quitarse y cada
  // reinstalación los duplicaría.
  it("encuentra nuestros hooks aunque los marcadores hayan desaparecido", () => {
    const { entries } = hooksTemplateToToml(TEMPLATE);
    const { text: installed } = upsertManagedHooksBlock(USER_CONFIG, entries);
    // El host reescribe el archivo: comentarios fuera, hooks dentro.
    const reserialized = `${stringifyToml(parseToml(installed) as never)}\n`;
    expect(reserialized).not.toContain(MANAGED_BLOCK_BEGIN);

    const swept = stripOurHookEntries(reserialized);
    expect(swept.removed).toBe(entries.length);
    const left = parseToml(swept.text) as { hooks?: { command: string }[] };
    expect(left.hooks?.map((h) => h.command)).toEqual(["my-own-script.sh"]);
  });

  it("tras la reescritura del host, reinstalar no duplica", () => {
    const { entries } = hooksTemplateToToml(TEMPLATE);
    const { text: installed } = upsertManagedHooksBlock(USER_CONFIG, entries);
    const reserialized = `${stringifyToml(parseToml(installed) as never)}\n`;

    const { text: again } = upsertManagedHooksBlock(reserialized, entries);
    const parsed = parseToml(again) as { hooks: { command: string }[] };
    expect(parsed.hooks).toHaveLength(entries.length + 1);
    expect(parsed.hooks.filter((h) => h.command.startsWith("agent-workflow"))).toHaveLength(
      entries.length,
    );
  });

  it("un hook del usuario cuyo comando NO es nuestro sobrevive al barrido", () => {
    const mixed = [
      "[[hooks]]",
      'event = "Stop"',
      'command = "agent-workflow-lookalike --not-ours"',
      "",
      "[[hooks]]",
      'event = "Stop"',
      'command = "agent-workflow hook branch-check"',
      "",
    ].join("\n");
    const { text, removed } = stripOurHookEntries(mixed);
    expect(removed).toBe(1);
    const parsed = parseToml(text) as { hooks: { command: string }[] };
    expect(parsed.hooks.map((h) => h.command)).toEqual(["agent-workflow-lookalike --not-ours"]);
  });

  // Se parsea con el MISMO parser TOML que usa el CLI: comprobar substrings
  // dejaba pasar un bloque sin la cabecera `[[hooks]]`, que ni siquiera es TOML
  // válido (las claves caerían en la tabla raíz).
  it("el bloque parsea como TOML y produce un [[hooks]] por entrada", () => {
    const { entries } = hooksTemplateToToml(TEMPLATE);
    const parsed = parseToml(renderManagedHooksBlock(entries)) as {
      hooks?: Record<string, unknown>[];
    };
    expect(parsed.hooks).toHaveLength(entries.length);
    expect(parsed.hooks?.[0]).toEqual({
      event: "SessionStart",
      command: "agent-workflow self namespace",
      timeout: 5,
    });
  });

  it("solo emite las 4 claves que el esquema estricto de kimi acepta", () => {
    const { entries } = hooksTemplateToToml(TEMPLATE);
    const parsed = parseToml(renderManagedHooksBlock(entries)) as {
      hooks: Record<string, unknown>[];
    };
    const keys = new Set(parsed.hooks.flatMap((h) => Object.keys(h)));
    expect(keys).toEqual(new Set(["event", "matcher", "command", "timeout"]));
  });

  it("el bloque instalado sobre la config del usuario sigue siendo TOML válido", () => {
    const { entries } = hooksTemplateToToml(TEMPLATE);
    const { text } = upsertManagedHooksBlock(USER_CONFIG, entries);
    const parsed = parseToml(text) as { hooks: Record<string, unknown>[]; default_model: string };
    // Los hooks del usuario y los nuestros conviven en el mismo array.
    expect(parsed.default_model).toBe("kimi-code/k3");
    expect(parsed.hooks).toHaveLength(entries.length + 1);
    expect(parsed.hooks[0]).toEqual({ event: "SessionEnd", command: "my-own-script.sh" });
  });
});

// El esquema estricto de kimi, validado como DATO antes de escribir. Existe por
// una razón asimétrica: su loader descarta la sección `hooks` ENTERA ante una
// sola entrada inválida, así que el costo de una entrada mala no es esa entrada
// — son todos los hooks del archivo, los nuestros y los del usuario.
describe("kimiHookEntryDefect", () => {
  const valid = { event: "PreToolUse", matcher: "Bash", command: "x", timeout: 30 };

  it("una entrada que cumple el esquema no tiene defecto", () => {
    expect(kimiHookEntryDefect(valid)).toBeNull();
    expect(kimiHookEntryDefect({ event: "Stop", command: "x" })).toBeNull();
  });

  it("rechaza lo que no es una tabla", () => {
    for (const value of [null, undefined, 42, "x", ["a"]]) {
      expect(kimiHookEntryDefect(value), String(value)).toBe("not a table");
    }
  });

  it("el esquema es ESTRICTO: una clave de más invalida la entrada", () => {
    expect(kimiHookEntryDefect({ ...valid, type: "command" })).toMatch(/unknown key\(s\) type/);
  });

  it("event y command son obligatorios, y el event tiene que existir en kimi", () => {
    expect(kimiHookEntryDefect({ command: "x" })).toMatch(/'event' is required/);
    expect(kimiHookEntryDefect({ event: "PreToolUse" })).toMatch(/'command' is required/);
    expect(kimiHookEntryDefect({ event: "PreToolUse", command: "" })).toMatch(
      /'command' is required/,
    );
    expect(kimiHookEntryDefect({ event: "PreCompactar", command: "x" })).toMatch(
      /not one of the events/,
    );
  });

  it("timeout: entero y dentro de 1..600", () => {
    expect(kimiHookEntryDefect({ ...valid, timeout: 0 })).toMatch(/between 1 and 600/);
    expect(kimiHookEntryDefect({ ...valid, timeout: 601 })).toMatch(/between 1 and 600/);
    expect(kimiHookEntryDefect({ ...valid, timeout: 1.5 })).toMatch(/must be an integer/);
    expect(kimiHookEntryDefect({ ...valid, timeout: "30" })).toMatch(/must be an integer/);
  });
});

describe("auditHooksSection", () => {
  it("una sección sana no tiene defectos y cuenta sus entradas", () => {
    const text = renderManagedHooksBlock(hooksTemplateToToml(TEMPLATE).entries);
    const audit = auditHooksSection(text, parseToml);
    expect(audit.parsed).toBe(true);
    if (audit.parsed) {
      expect(audit.total).toBe(4);
      expect(audit.defects).toEqual([]);
    }
  });

  it("un archivo sin hooks es una sección válida y vacía, no un error", () => {
    const audit = auditHooksSection('default_model = "k3"\n', parseToml);
    expect(audit.parsed).toBe(true);
    if (audit.parsed) expect(audit.total).toBe(0);
  });

  it("distingue de QUIÉN es la entrada inválida: la nuestra la firmamos, la del usuario no", () => {
    const text = [
      "[[hooks]]",
      'event = "NoExiste"',
      'command = "agent-workflow hook x"',
      "",
      "[[hooks]]",
      'event = "TampocoExiste"',
      'command = "mi-script.sh"',
      "",
    ].join("\n");
    const audit = auditHooksSection(text, parseToml);
    expect(audit.parsed).toBe(true);
    if (!audit.parsed) return;
    expect(audit.defects.map((d) => [d.index, d.ours, d.event])).toEqual([
      [0, true, "NoExiste"],
      [1, false, "TampocoExiste"],
    ]);
  });

  it("un archivo que no parsea se reporta como tal, sin inventar defectos", () => {
    const audit = auditHooksSection("esto = no [ es toml", parseToml);
    expect(audit.parsed).toBe(false);
    expect(audit.defects).toEqual([]);
  });
});
