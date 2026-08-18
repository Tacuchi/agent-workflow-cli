import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PathsService } from "../../src/application/paths-service.js";
import {
  resolveBundledHookTemplate,
  selfInstallHooks,
} from "../../src/application/self/install-hooks.js";
import type { ParsedArgs } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import type { ResolvedRuntime } from "../../src/runtime/types.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { FakeProcess } from "../helpers/fake-process.js";
import { NoScanFs } from "../helpers/real-fs.js";

const VALID_TEMPLATE = {
  hooks: {
    SessionStart: [
      {
        matcher: "startup|resume|clear",
        hooks: [{ type: "command", command: "agent-workflow hook session-start", timeout: 5 }],
      },
    ],
    PreToolUse: [
      {
        matcher: "Edit|Write|MultiEdit|NotebookEdit",
        hooks: [{ type: "command", command: "agent-workflow hook branch-check", timeout: 15 }],
      },
    ],
    SessionEnd: [
      {
        matcher: "",
        hooks: [{ type: "command", command: "agent-workflow auto-compact-on-close", timeout: 10 }],
      },
    ],
  },
};

function buildArgs(values: Record<string, string>, flags: string[] = []): ParsedArgs {
  return {
    rest: ["install-hooks"],
    plugin: {},
    flags: new Set(flags),
    values: new Map(Object.entries(values)),
    valuesMulti: new Map(),
  };
}

function buildCtx(home: string): CliContext {
  const ns = normalizeNamespace("agent-workflow");
  const runtime: ResolvedRuntime = {
    packageName: "@tacuchi/agent-workflow-cli",
    binName: "agent-workflow",
    source: "default",
  };
  return {
    fs: new NoScanFs(),
    env: new FakeEnv(home),
    process: new FakeProcess({ run: () => ({ code: 0, stdout: "", stderr: "" }) }),
    git: {} as never,
    namespace: { namespace: ns, source: "default" },
    runtime,
    paths: new PathsService(ns, home, home),
  };
}

describe("selfInstallHooks", () => {
  let workdir: string;
  let home: string;
  let templatePath: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "aw-hooks-test-"));
    home = join(workdir, "home");
    templatePath = join(workdir, "hooks.template.json");
    await mkdir(home, { recursive: true });
    await writeFile(templatePath, JSON.stringify(VALID_TEMPLATE), "utf8");
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it("--target required → TARGET_REQUIRED", async () => {
    const result = await selfInstallHooks(buildArgs({ template: templatePath }), buildCtx(home));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("TARGET_REQUIRED");
  });

  it("--target invalid → INVALID_TARGET", async () => {
    const result = await selfInstallHooks(
      buildArgs({ target: "bogus", template: templatePath }),
      buildCtx(home),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_TARGET");
  });

  // A target Workline does NOT manage resolves to the explanatory "unsupported"
  // result (warning + null config_path), not a generic INVALID_TARGET — the
  // daily-status documents them as valid hosts. Only warp and oz are left: they
  // have no hook system at all. crush and gemini got config installers, codex a
  // generated bundle and opencode a generated plugin module.
  it.each(["warp", "oz"])("--target %s → unsupported (not INVALID_TARGET)", async (target) => {
    const result = await selfInstallHooks(
      buildArgs({ target, template: templatePath }),
      buildCtx(home),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.status).toBe("unsupported");
      expect(result.data.warning).toContain(target);
      expect(result.data.config_path).toBeNull();
    }
  });

  it("--target claude (no existing settings) → installs all events", async () => {
    const result = await selfInstallHooks(
      buildArgs({ target: "claude", template: templatePath }),
      buildCtx(home),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.status).toBe("installed");
      expect(result.data.events_installed).toEqual(
        expect.arrayContaining(["SessionStart", "PreToolUse", "SessionEnd"]),
      );
      expect(result.data.events_already_present).toEqual([]);
      expect(result.data.backup_path).toBeNull();
      expect(result.data.config_path).toBe(join(home, ".claude", "settings.json"));
    }
    const content = JSON.parse(await readFile(join(home, ".claude", "settings.json"), "utf8"));
    expect(content.hooks.SessionStart).toBeDefined();
    expect(content.hooks.PreToolUse).toBeDefined();
    expect(content.hooks.SessionEnd).toBeDefined();
  });

  it("--target claude with same hooks → noop (idempotent)", async () => {
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ hooks: VALID_TEMPLATE.hooks }, null, 2),
      "utf8",
    );

    const result = await selfInstallHooks(
      buildArgs({ target: "claude", template: templatePath }),
      buildCtx(home),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.status).toBe("noop");
      expect(result.data.events_installed).toEqual([]);
      expect(result.data.events_already_present.length).toBe(3);
    }
  });

  it("--target claude preserves OTHER top-level keys in settings.json", async () => {
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(
      join(home, ".claude", "settings.json"),
      JSON.stringify(
        {
          permissions: { allow: ["Bash"], additionalDirectories: ["/extra"] },
          customField: "preserved",
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await selfInstallHooks(
      buildArgs({ target: "claude", template: templatePath }),
      buildCtx(home),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.data) expect(result.data.status).toBe("installed");

    const after = JSON.parse(await readFile(join(home, ".claude", "settings.json"), "utf8"));
    expect(after.permissions.allow).toEqual(["Bash"]);
    expect(after.permissions.additionalDirectories).toEqual(["/extra"]);
    expect(after.customField).toBe("preserved");
    expect(after.hooks.SessionStart).toBeDefined();
  });

  it("--target claude with existing different hooks → backup created", async () => {
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ hooks: { SessionStart: [{ matcher: "old", hooks: [] }] } }, null, 2),
      "utf8",
    );

    const result = await selfInstallHooks(
      buildArgs({ target: "claude", template: templatePath }),
      buildCtx(home),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.status).toBe("installed");
      expect(result.data.backup_path).not.toBeNull();
    }
  });

  it("--target claude --dry-run reports plan, does not write", async () => {
    const result = await selfInstallHooks(
      buildArgs({ target: "claude", template: templatePath }, ["--dry-run"]),
      buildCtx(home),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.status).toBe("dry-run");
      expect(result.data.events_installed.length).toBeGreaterThan(0);
    }
    // settings.json should not be created
    let existed = false;
    try {
      await stat(join(home, ".claude", "settings.json"));
      existed = true;
    } catch {
      // expected
    }
    expect(existed).toBe(false);
  });

  it("invalid JSON in settings.json → SETTINGS_INVALID_JSON", async () => {
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(join(home, ".claude", "settings.json"), "{not valid", "utf8");
    const result = await selfInstallHooks(
      buildArgs({ target: "claude", template: templatePath }),
      buildCtx(home),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("SETTINGS_INVALID_JSON");
  });

  it("missing template → TEMPLATE_NOT_FOUND", async () => {
    const result = await selfInstallHooks(
      buildArgs({ target: "claude", template: "/non/existent.json" }),
      buildCtx(home),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("TEMPLATE_NOT_FOUND");
  });

  it("invalid JSON in template → TEMPLATE_INVALID_JSON", async () => {
    const bad = join(workdir, "bad.json");
    await writeFile(bad, "{not valid", "utf8");
    const result = await selfInstallHooks(
      buildArgs({ target: "claude", template: bad }),
      buildCtx(home),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("TEMPLATE_INVALID_JSON");
  });

  // T2.3 — REGRESIÓN de claude contra la plantilla REAL del bundle, no una
  // reducida de test: los 5 eventos que la plantilla declara tienen que quedar
  // mergeados en settings.json tal cual, sin transformación y sin pérdidas. Los
  // demás tests de claude usan una plantilla de 3 eventos; este cierra la
  // distancia entre "el merge funciona" y "el merge funciona con lo que enviamos".
  it("claude: la plantilla REAL del bundle mergea sus 5 eventos sin transformar ni degradar", async () => {
    const bundled = await resolveBundledHookTemplate();
    expect(bundled, "la plantilla del bundle tiene que resolverse").not.toBeNull();
    const template = JSON.parse(await readFile(bundled as string, "utf8"));
    const events = Object.keys(template.hooks);
    expect(events).toEqual([
      "SessionStart",
      "PreToolUse",
      "SessionEnd",
      "PreCompact",
      "PostCompact",
    ]);

    const result = await selfInstallHooks(
      buildArgs({ target: "claude", template: bundled as string }),
      buildCtx(home),
    );
    expect(result.ok).toBe(true);
    expect(result.data?.status).toBe("installed");
    expect(result.data?.events_installed).toEqual(events);
    // Ninguna degradación: claude no transforma nada.
    expect(result.data?.warning).toBeUndefined();

    const written = JSON.parse(await readFile(join(home, ".claude", "settings.json"), "utf8")) as {
      hooks: Record<string, unknown>;
    };
    // Byte a byte lo que la plantilla declara, incluidos los 3 grupos de
    // PreToolUse y el hook `type: "prompt"` de PostCompact que kimi NO expresa.
    expect(written.hooks).toEqual(template.hooks);
    expect((written.hooks.PreToolUse as unknown[]).length).toBe(3);
    const postCompact = written.hooks.PostCompact as { hooks: { type: string }[] }[];
    expect(postCompact[0]?.hooks.map((h) => h.type)).toContain("prompt");
  });

  it("template missing 'hooks' key → TEMPLATE_INVALID_SCHEMA", async () => {
    const bad = join(workdir, "bad-schema.json");
    await writeFile(bad, JSON.stringify({ other: {} }), "utf8");
    const result = await selfInstallHooks(
      buildArgs({ target: "claude", template: bad }),
      buildCtx(home),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("TEMPLATE_INVALID_SCHEMA");
  });
});

// ─── Kimi Code: TOML dialect, and the host that rewrites its own config ──────
//
// The wiring around `hooksTemplateToToml` was the untested half: statuses,
// backup, the degradation warning, and — the one that bit — ownership surviving
// Kimi's own re-serialization of `config.toml`, which drops every comment while
// keeping the `hooks` array.
describe("selfInstallHooks — kimi", () => {
  let workdir: string;
  let home: string;
  let templatePath: string;
  let configPath: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "aw-hooks-kimi-"));
    home = join(workdir, "home");
    templatePath = join(workdir, "hooks.template.json");
    configPath = join(home, ".kimi-code", "config.toml");
    await mkdir(join(home, ".kimi-code"), { recursive: true });
    await writeFile(templatePath, JSON.stringify(VALID_TEMPLATE), "utf8");
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  const USER_CONFIG = [
    'default_model = "kimi-code/k3"',
    "",
    "[thinking]",
    "enabled = true",
    "",
  ].join("\n");

  async function install(flags: string[] = []) {
    return selfInstallHooks(
      buildArgs({ target: "kimi", template: templatePath }, flags),
      buildCtx(home),
    );
  }

  it("instala los hooks como [[hooks]] y deja la config del usuario intacta", async () => {
    await writeFile(configPath, USER_CONFIG, "utf8");
    const result = await install();

    expect(result.ok).toBe(true);
    expect(result.data?.status).toBe("installed");
    expect(result.data?.config_path).toBe(configPath);
    expect(result.data?.events_installed).toEqual(["SessionStart", "PreToolUse", "SessionEnd"]);

    const written = await readFile(configPath, "utf8");
    const parsed = parseToml(written) as { hooks: Record<string, unknown>[]; thinking: unknown };
    expect(parsed.hooks).toHaveLength(3);
    expect(parsed.thinking).toEqual({ enabled: true });
    expect(written.startsWith(USER_CONFIG)).toBe(true);
  });

  it("respalda el archivo antes de escribirlo", async () => {
    await writeFile(configPath, USER_CONFIG, "utf8");
    const result = await install();
    expect(result.data?.backup_path).toBeTruthy();
    expect(await readFile(result.data?.backup_path as string, "utf8")).toBe(USER_CONFIG);
  });

  it("reinstalar es noop: no reescribe ni deja un respaldo nuevo", async () => {
    await writeFile(configPath, USER_CONFIG, "utf8");
    await install();
    const afterFirst = await readFile(configPath, "utf8");

    const second = await install();
    expect(second.data?.status).toBe("noop");
    expect(second.data?.backup_path).toBeNull();
    expect(await readFile(configPath, "utf8")).toBe(afterFirst);
  });

  it("--dry-run no escribe nada", async () => {
    await writeFile(configPath, USER_CONFIG, "utf8");
    const result = await install(["--dry-run"]);
    expect(result.data?.status).toBe("dry-run");
    expect(await readFile(configPath, "utf8")).toBe(USER_CONFIG);
  });

  it("reporta lo que el dialecto de kimi no puede expresar", async () => {
    await writeFile(
      templatePath,
      JSON.stringify({
        hooks: {
          PostCompact: [
            {
              matcher: "",
              hooks: [
                { type: "command", command: "agent-workflow resume-summary", timeout: 10 },
                { type: "prompt", prompt: "reanudá" },
              ],
            },
          ],
          UnEventoQueKimiNoConoce: [
            { matcher: "", hooks: [{ type: "command", command: "agent-workflow x" }] },
          ],
        },
      }),
      "utf8",
    );
    const result = await install();
    expect(result.data?.warning).toMatch(/prompt/);
    expect(result.data?.warning).toMatch(/UnEventoQueKimiNoConoce/);
    // Y lo que no se puede expresar NO se escribe: kimi tira TODA su sección de
    // hooks si una entrada no valida, incluidos los del usuario.
    const parsed = parseToml(await readFile(configPath, "utf8")) as {
      hooks: { event: string }[];
    };
    expect(parsed.hooks.map((h) => h.event)).toEqual(["PostCompact"]);
  });

  // REGRESIÓN: kimi reescribe su config.toml en operaciones suyas normales
  // (login, quitar un provider…) y borra TODOS los comentarios, conservando el
  // array `hooks`. Si la propiedad fuera el marcador, nuestros hooks quedarían
  // sin forma de quitarse y se duplicarían en cada reinstalación.
  it("sobrevive a que kimi reescriba el archivo y borre los comentarios", async () => {
    await writeFile(configPath, USER_CONFIG, "utf8");
    await install();

    // Simula la re-serialización del propio host: parse + stringify.
    const reserialized = stringifyToml(parseToml(await readFile(configPath, "utf8")) as never);
    await writeFile(configPath, `${reserialized}\n`, "utf8");
    expect(await readFile(configPath, "utf8")).not.toContain("agent-workflow (Workline)");

    // Reinstalar NO duplica.
    const again = await install();
    expect(again.ok).toBe(true);
    const parsed = parseToml(await readFile(configPath, "utf8")) as { hooks: unknown[] };
    expect(parsed.hooks).toHaveLength(3);
  });

  // ————— F2: la sección COMPLETA resultante se valida antes de escribir —————
  //
  // El defecto que estos tests cierran: validábamos NUESTRA transformación y
  // escribíamos al lado de lo que el usuario ya tenía. Como el loader de kimi
  // descarta la sección `hooks` ENTERA ante una sola entrada inválida, una
  // entrada mala preexistente del usuario desarmaba también nuestros hooks — y
  // la instalación decía "installed".

  it("una entrada inválida PREEXISTENTE del usuario bloquea la escritura y se reporta como suya", async () => {
    const withBadUserHook = [
      USER_CONFIG,
      "[[hooks]]",
      'event = "EstoNoEsUnEvento"',
      'command = "mi-script.sh"',
      "",
    ].join("\n");
    await writeFile(configPath, withBadUserHook, "utf8");

    const result = await install();

    expect(result.ok).toBe(true);
    expect(result.data?.status).toBe("blocked");
    expect(result.data?.events_installed).toEqual([]);
    expect(result.data?.warning).toContain("Nothing was written");
    expect(result.data?.warning).toContain("already in your config");
    expect(result.data?.warning).toContain("EstoNoEsUnEvento");
    // Y sobre todo: el archivo del usuario quedó BYTE POR BYTE como estaba.
    expect(await readFile(configPath, "utf8")).toBe(withBadUserHook);
  });

  it("una entrada preexistente del usuario que sí valida no bloquea nada y se conserva", async () => {
    const withGoodUserHook = [
      USER_CONFIG,
      "[[hooks]]",
      'event = "PostToolUse"',
      'matcher = "Bash"',
      'command = "mi-script.sh"',
      "timeout = 30",
      "",
    ].join("\n");
    await writeFile(configPath, withGoodUserHook, "utf8");

    const result = await install();

    expect(result.data?.status).toBe("installed");
    const parsed = parseToml(await readFile(configPath, "utf8")) as {
      hooks: { event: string; command: string }[];
    };
    // Los 3 nuestros + el del usuario, intacto.
    expect(parsed.hooks).toHaveLength(4);
    expect(parsed.hooks.some((h) => h.command === "mi-script.sh")).toBe(true);
  });

  it("un timeout fuera de rango en un hook del usuario también bloquea, nombrando el límite", async () => {
    const withBadTimeout = [
      USER_CONFIG,
      "[[hooks]]",
      'event = "Stop"',
      'command = "mi-script.sh"',
      "timeout = 9000",
      "",
    ].join("\n");
    await writeFile(configPath, withBadTimeout, "utf8");

    const result = await install();
    expect(result.data?.status).toBe("blocked");
    expect(result.data?.warning).toMatch(/timeout.*between 1 and 600/);
    expect(await readFile(configPath, "utf8")).toBe(withBadTimeout);
  });

  it("la razón del bloqueo explica la consecuencia: kimi tira TODA la sección", async () => {
    await writeFile(
      configPath,
      [USER_CONFIG, "[[hooks]]", 'event = "Nope"', 'command = "x"', ""].join("\n"),
      "utf8",
    );
    const result = await install();
    expect(result.data?.warning).toContain("ENTIRE hooks section");
    expect(result.data?.warning).toContain("yours included");
  });

  // ————— F2: las degradaciones declaradas de kimi son VISIBLES —————

  it("el matcher que no viaja se declara en el output de install, no se descarta en silencio", async () => {
    await writeFile(configPath, USER_CONFIG, "utf8");
    const result = await install();

    expect(result.data?.status).toBe("installed");
    // SessionStart lleva matcher "startup|resume|clear" en la plantilla, y kimi lo
    // testea contra el vocabulario del evento, no contra el nombre de la tool.
    expect(result.data?.warning).toContain("declared degradation");
    expect(result.data?.warning).toContain("SessionStart");
    // El hook SÍ se instaló; lo que se perdió es el matcher.
    const parsed = parseToml(await readFile(configPath, "utf8")) as {
      hooks: { event: string; matcher?: string }[];
    };
    const sessionStart = parsed.hooks.find((h) => h.event === "SessionStart");
    expect(sessionStart).toBeDefined();
    expect(sessionStart?.matcher).toBeUndefined();
    // Y el de PreToolUse, cuyo matcher SÍ transfiere, lo conserva.
    expect(parsed.hooks.find((h) => h.event === "PreToolUse")?.matcher).toBe(
      "Edit|Write|MultiEdit|NotebookEdit",
    );
  });

  it("omitido y degradado se reportan como cosas distintas: uno no está, el otro está a medias", async () => {
    await writeFile(
      templatePath,
      JSON.stringify({
        hooks: {
          PostCompact: [
            {
              matcher: "",
              hooks: [
                { type: "command", command: "agent-workflow resume-summary", timeout: 10 },
                { type: "prompt", prompt: "reanudá" },
              ],
            },
          ],
          SessionStart: [
            {
              matcher: "startup|resume|clear",
              hooks: [{ type: "command", command: "agent-workflow hook session-start" }],
            },
          ],
        },
      }),
      "utf8",
    );
    const result = await install();
    const warning = result.data?.warning ?? "";
    expect(warning).toContain("skipped");
    expect(warning).toMatch(/prompt/);
    expect(warning).toContain("declared degradation");
    expect(warning).toContain("SessionStart");
  });
});
