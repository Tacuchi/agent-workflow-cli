import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ALL_COMMANDS } from "../../src/cli/commands/index.js";
import { commandHelpText, groupCommands } from "../../src/cli/help-groups.js";
import { resolveOutputMode } from "../../src/cli/output-mode.js";
import { parseArgv } from "../../src/cli/parser.js";
import { CommandRegistry } from "../../src/cli/registry.js";

/**
 * The cross-cutting matrix of spec 012 (C1–C18): the surviving direct surfaces, their
 * output projections, their write boundary and their distribution.
 *
 * Per-command behavior is proven by each service's own suite. What only shows up
 * here is the COHERENCE between them — the drift this plan exists to remove.
 */

const SKILL_ROOT = resolve(__dirname, "..", "..", "skills", "w");

/** The direct commands still available, with their classification. */
const SURFACES = [
  { name: "status", kind: "cli-complete", writes: null },
  { name: "resume", kind: "cli-complete", writes: null },
  { name: "hub-init", kind: "cli-complete", writes: ".workflow" },
  { name: "persist", kind: "hybrid", writes: "docs/research|specs|plans" },
  { name: "export-diagrams", kind: "hybrid", writes: "docs/diagrams" },
  { name: "export-manuals", kind: "hybrid", writes: "docs/manuals" },
  { name: "export-reports", kind: "hybrid", writes: "docs/reports" },
  { name: "export-scripts", kind: "hybrid", writes: "docs/scripts" },
] as const;

function purposes(): ReadonlyMap<string, string> {
  return new Map(ALL_COMMANDS.map((command) => [command.name, command.help.purpose]));
}

function registry(): CommandRegistry {
  const reg = new CommandRegistry();
  for (const command of ALL_COMMANDS) reg.register(command);
  return reg;
}

// ── C1 · the surviving surfaces exist and are reachable ─────────────────────

describe("C1 · every declared surface is a real, registered command", () => {
  it.each(SURFACES.map((s) => s.name))("`aw %s` resolves", (name) => {
    expect(registry().resolve(name)).toBeDefined();
  });

  it("no command falls into the help catch-all", () => {
    // Hook targets are listed apart, by their attribute: they have no family.
    const agentFacing = ALL_COMMANDS.filter((command) => command.hook !== true);
    const groups = groupCommands(agentFacing.map((command) => command.name));
    expect(groups.find((g) => g.name === "Other")).toBeUndefined();
  });

  it("set-pipeline se publica en la familia de fuentes", () => {
    expect(
      groupCommands(registry().list()).find((g) => g.name === "Sources / Branches")?.commands,
    ).toContain("set-pipeline");
    expect(purposes().get("set-pipeline")).toMatch(/build or test/);
  });

  it("every surface carries a help whose usage names it", () => {
    for (const surface of SURFACES) {
      const command = registry().resolve(surface.name);
      expect(command ? commandHelpText(command) : "", surface.name).toContain(
        `Usage: aw ${surface.name}`,
      );
    }
  });

  // Three commands share the `resume` stem and three different audiences.
  it("the three resume-shaped commands stay distinguishable", () => {
    const describes = purposes();
    expect(describes.get("resume")).toMatch(/what to resume/i);
    expect(describes.get("hook")).toContain("post-compact");
    expect(describes.get("session-load")).toContain("session");
  });
});

// ── C12/C13 · output projections ─────────────────────────────────────────────

describe("C12/C13 · the output matrix is one rule for every command", () => {
  const matrix: Array<[string[], boolean, "human" | "json", boolean]> = [
    [[], false, "json", false], // pipe, no override → the JSON automation parses
    [[], true, "human", false], // terminal, no override → compact prose
    [["--json"], true, "json", false], // explicit machine, inside a terminal
    [["--format", "human"], false, "human", false], // explicit human, through a pipe
    [["--detail"], false, "human", true], // detail implies the human projection
    [["--detail", "--format", "human"], true, "human", true],
    [["--detail", "--json"], true, "json", true], // detail widens a projected JSON too
  ];

  it.each(matrix)("argv %j on TTY=%s → %s (detail=%s)", (argv, isTTY, format, detail) => {
    const resolution = resolveOutputMode(parseArgv(["status", ...argv]), isTTY);
    if (!resolution.ok) throw new Error(`expected a mode: ${resolution.message}`);
    expect(resolution.mode).toEqual({ format, detail, ascii: false });
  });

  it("rejects the contradictions instead of picking a winner", () => {
    for (const argv of [
      ["--json", "--format", "human"],
      ["--format", "yaml"],
    ]) {
      expect(resolveOutputMode(parseArgv(["status", ...argv]), true).ok, argv.join(" ")).toBe(
        false,
      );
    }
  });

  it("every declared surface carries the human projection", () => {
    const withRenderer = new Set(
      ALL_COMMANDS.filter((c) => c.renderHuman !== undefined).map((c) => c.name),
    );
    for (const surface of SURFACES) expect(withRenderer.has(surface.name), surface.name).toBe(true);
  });

  // The compatibility floor: every command that existed before spec 012 keeps
  // emitting JSON in a terminal, exactly as it did then — the floor is about the
  // DEFAULT output mode, so an older command may still gain a projection for
  // `--format human` without breaking it. Adopters are listed here, by name, one
  // line per adopter, whether they arrived later or adopted it later. What the
  // guard refuses is a command acquiring a renderer without anyone declaring it.
  const LATER_ADOPTERS: readonly string[] = [
    "context-budget", // plan 010 — the context budget report
    "context-plan", // plan 010 — the read-set an invocation must load
    "skills", // plan 014 — capability readiness, widened only under --detail
    "flow", // plan 015 — the boundary directive, derived from the same directive
    "session-artifacts", // plan 022 — el recorrido de la sesión, bajo --format human
    // plan 024 — la vista previa de un retiro y su resultado. La proyección humana
    // es obligatoria acá, no opcional: lo que una persona aprueba es exactamente
    // este texto, y el JSON del host de agente sale del mismo objeto sellado.
    "discard",
    "reset",
    // WS-9 — el drift de visibilidad host por host, proyectado del mismo
    // resultado que viaja en el JSON. Era el único comando sin proyección
    // humana: `--format human` imprimía el JSON crudo.
    "visibility",
    // plan 026 F5 — la vista previa de la migración de un hub legacy. La
    // proyección humana es obligatoria acá por la misma razón que en `discard`:
    // lo que una persona lee antes de tipear `--apply` es exactamente este
    // texto, y sale del mismo plan que viaja en el JSON.
    "hub-migrate",
    // La mudanza informa cada referencia reparada y cualquier archivo manual preservado.
    "hub-move",
    // La vista previa de un re-sello, y la razón es la misma que en `discard`
    // llevada un paso más lejos: re-sellar es una AFIRMACIÓN humana («revisé el
    // plan contra la spec vigente y sigue valiendo»), así que lo que una persona
    // lee —sello vigente, sello nuevo, la línea exacta— es lo que aprueba con el
    // digest, y el JSON del host sale del mismo objeto sellado.
    "reseal",
    // plan 040 — el informe agregado del doctor. La proyección humana es
    // obligatoria acá porque el veredicto viaja en el CÓDIGO DE SALIDA y no en
    // `ok`: si el informe fuera `ok:false` al bloquear, el runtime no llamaría a
    // `renderHuman` y la persona vería una línea de error justo cuando necesita
    // el informe entero.
    "doctor",
    // La corrección directa de una redacción cerrada, por la misma razón que
    // `reseal` llevada un paso más lejos: lo que una persona lee después de
    // corregir —qué se reemplazó, con qué, bajo qué declaración y con qué
    // comando se deshace— es exactamente lo que el registro append-only guarda,
    // y el JSON del host sale del mismo objeto.
    "amend",
    // El saldo de una obligación, y la razón es la de `reseal` una vez más:
    // aplicar AFIRMA que el trabajo compensatorio se hizo, o que era de otra
    // gente. Lo que una persona lee —cada obligación con su clase, si esa clase
    // la declaró alguien, qué suelta el sucesor y qué conserva— es exactamente
    // lo que aprueba con el digest, y el JSON del host sale del mismo objeto.
    "settle",
    // plan 055 — el lint de un plan: la proyección humana lista cada violación
    // con su línea, su regla y el gate que la juzga, del mismo informe que viaja
    // en el JSON; el veredicto viaja en el código de salida, como en `doctor`.
    "plan",
    // F7: la propuesta del commit exhibe las rutas, exclusiones, mensaje y
    // digest que la persona aprueba; JSON y vista humana proyectan el mismo sello.
    "hub-commit",
  ];

  it("no undeclared command acquired a human projection", () => {
    const declared = new Set<string>([...SURFACES.map((s) => s.name), ...LATER_ADOPTERS]);
    const others = ALL_COMMANDS.filter((c) => !declared.has(c.name) && c.renderHuman !== undefined);
    expect(others.map((c) => c.name)).toEqual([]);
  });
});

// ── C1/C9 · the skills delegate instead of re-deriving ───────────────────────

describe("C1/C9 · every wrapper invokes the CLI and re-decides nothing", () => {
  it.each(SURFACES.map((s) => s.name))("`%s.md` invokes its own CLI command", async (name) => {
    const doc = await readFile(join(SKILL_ROOT, "commands", `${name}.md`), "utf8");
    expect(doc).toContain(`aw ${name} `);
  });

  it.each(SURFACES.filter((s) => s.kind === "hybrid").map((s) => s.name))(
    "`%s.md` states the CLI owns the write",
    async (name) => {
      const doc = await readFile(join(SKILL_ROOT, "commands", `${name}.md`), "utf8");
      expect(doc).toMatch(/Never write into `docs\/`|Never edit a conflicted file/);
    },
  );

  // The 34,9 KB the exports used to load on every invocation. Plan 010 removed
  // the trailing `## Resources` pointer lists, so the normal path is now the
  // whole body: assert over all of it instead of a slice that ended at a
  // heading which no longer exists.
  it("no export wrapper loads its EXPORT.md on the normal path", async () => {
    for (const category of ["diagrams", "manuals", "reports", "scripts"]) {
      const doc = await readFile(join(SKILL_ROOT, "commands", `export-${category}.md`), "utf8");
      // What matters is the NORMAL PATH: the `## Run` steps must not send the
      // agent into the manual. A markdown link names the file twice by
      // construction, so counting occurrences measured formatting, not loading.
      const run = doc.slice(doc.indexOf("## Run"));
      const runSteps = run.slice(0, run.indexOf("\n## ") === -1 ? undefined : run.indexOf("\n## "));
      expect(runSteps, category).not.toContain("EXPORT.md");
      expect(doc, category).toContain("no longer loaded on the normal path");
    }
  });

  it("no direct wrapper keeps a write tool in allowed-tools", async () => {
    for (const surface of SURFACES) {
      const doc = await readFile(join(SKILL_ROOT, "commands", `${surface.name}.md`), "utf8");
      const frontmatter = doc.slice(0, doc.indexOf("\n---", 4));
      expect(frontmatter, surface.name).not.toContain('"Write"');
      expect(frontmatter, surface.name).not.toContain('"Edit"');
    }
  });
});

// ── C15/C16/C18 · the write boundary, declared per surface ───────────────────

describe("C15/C16/C18 · each surface declares one destination and no session", () => {
  it("the read-only surfaces declare no destination at all", () => {
    const readOnly = SURFACES.filter((s) => s.writes === null).map((s) => s.name);
    expect(readOnly).toEqual(["status", "resume"]);
  });

  it("the four exports own four disjoint folders", () => {
    const folders = SURFACES.filter((s) => s.name.startsWith("export-")).map((s) => s.writes);
    expect(folders).toEqual(["docs/diagrams", "docs/manuals", "docs/reports", "docs/scripts"]);
    expect(new Set(folders).size).toBe(folders.length);
  });

  it("no direct surface documents creating a session", async () => {
    for (const surface of SURFACES) {
      const doc = await readFile(join(SKILL_ROOT, "commands", `${surface.name}.md`), "utf8");
      expect(doc, surface.name).not.toMatch(/aw session-create/);
    }
  });
});

// ── cost fixture (spec 009 consumes it; no threshold is set here) ────────────

describe("activation cost — recorded, not budgeted", () => {
  it("records the wrapper bytes of the ten surfaces", async () => {
    const sizes: Record<string, number> = {};
    for (const surface of SURFACES) {
      const doc = await readFile(join(SKILL_ROOT, "commands", `${surface.name}.md`), "utf8");
      sizes[surface.name] = Buffer.byteLength(doc, "utf8");
    }
    // Deliberately no threshold: spec 009 owns the budgets. What this pins is
    // that the numbers stay MEASURABLE and that the migration did not make the
    // normal path heavier than the doctrine it replaced (15 434 B for
    // status+resume alone, plus 34 900 B of export manuals).
    const total = Object.values(sizes).reduce((a, b) => a + b, 0);
    expect(total).toBeLessThan(15_434 + 34_900);
    expect(Object.keys(sizes)).toHaveLength(8);
  });
});
