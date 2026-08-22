// El estampado del binding por host: lo que la superficie INSTALADA le dice al
// agente sobre cómo presentar una frontera humana en ESE host.
//
// El defecto que estos tests cierran ya estaba en producción: la presentación
// nativa era doctrina neutra y los wrappers instalados llevaban el MISMO texto en
// los ocho hosts, así que nada le decía al agente en qué host corría ni qué
// mecanismo usar. La detección en runtime no lo resuelve — `aw harness` responde
// `unknown` dentro de Kimi Code —, así que el único momento en que el destino se
// conoce es la instalación, y es ahí donde se estampa.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PathsService } from "../../src/application/paths-service.js";
import { selfInstallSkill } from "../../src/application/self/install-skill.js";
import type { ParsedArgs } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
import { HARNESSES, type HarnessId, harnessById } from "../../src/domain/harnesses.js";
import {
  renderStructuredChoiceStamp,
  stampForInstallTarget,
} from "../../src/domain/structured-choice-stamp.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import type { ResolvedRuntime } from "../../src/runtime/types.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { FakeProcess } from "../helpers/fake-process.js";
import { NoScanFs as RealFs } from "../helpers/real-fs.js";

function specOf(id: HarnessId) {
  const spec = harnessById(id);
  if (spec === null) throw new Error(`host ausente del catálogo: ${id}`);
  return spec;
}

describe("renderStructuredChoiceStamp — el mecanismo de ESTE host, no uno genérico", () => {
  it("un host nativo nombra su herramienta, sus techos y el slot de `flow`", () => {
    const stamp = renderStructuredChoiceStamp(specOf("kimi"));
    expect(stamp).toContain("`AskUserQuestion`");
    expect(stamp).toContain("at most 4 questions per call and 4 options each");
    expect(stamp).toContain("reserving one question slot for the `flow` control");
    // Label y oración funcional van a campos propios en kimi.
    expect(stamp).toContain("their own fields");
    // El forzado que pide la doctrina: mientras la herramienta alcanza, la
    // frontera jamás se presenta como prosa.
    expect(stamp).toContain("never render a boundary as plain prose");
  });

  it("la regla de no duplicar `Other` aparece exactamente donde el host ya ofrece respuesta libre", () => {
    expect(renderStructuredChoiceStamp(specOf("kimi"))).toContain(
      "do not add an `Other` option of your own",
    );
    // Derivado, no deletreado: si un host cambia de opinión sobre su respuesta
    // libre, este test lo persigue en vez de quedarse pineado a un host. La regla
    // acompaña a la HERRAMIENTA (también gateada por turno), nunca al fallback.
    for (const spec of HARNESSES) {
      const expected =
        spec.structuredChoice.state !== "unsupported" &&
        spec.structuredChoice.tool !== null &&
        spec.structuredChoice.customAnswer;
      const hasRule = renderStructuredChoiceStamp(spec).includes("`Other` option");
      expect(hasRule, spec.id).toBe(expected);
    }
  });

  it("un host nativo declara CUÁNDO cae a markdown, no sólo que existe un fallback", () => {
    const kimi = renderStructuredChoiceStamp(specOf("kimi"));
    expect(kimi).toContain("fall back to labeled markdown");
    expect(kimi).toContain("`auto`");
    expect(kimi).toContain("non-interactive");
    const opencode = renderStructuredChoiceStamp(specOf("opencode"));
    expect(opencode).toContain("`question` permission set to `deny`");
  });

  it("gemini/Antigravity dobla la oración en la etiqueta: su opción no tiene campo de descripción", () => {
    const stamp = renderStructuredChoiceStamp(specOf("gemini"));
    expect(stamp).toContain("`AskQuestion`");
    // `ask_user` es del Gemini CLI retirado y NO está en el binario instalado.
    expect(stamp).not.toContain("ask_user");
    expect(stamp).toContain("one visible option string");
    expect(stamp).toContain("render `Label — functional sentence`");
  });

  it("un host sin techos declarados NO recibe un techo inventado: cae al ≤3 del chasis", () => {
    const stamp = renderStructuredChoiceStamp(specOf("opencode"));
    expect(stamp).toContain("does not declare");
    expect(stamp).toContain("≤3 content questions");
    expect(stamp).not.toMatch(/at most \d+ questions per call/);
  });

  it("crush declara su tope de 100 caracteres por opción como degradación, no como recorte", () => {
    const stamp = renderStructuredChoiceStamp(specOf("crush"));
    expect(stamp).toContain("at most 5 questions per call and 5 options each");
    expect(stamp).toContain("caps that sentence at 100 characters");
    expect(stamp).toContain("degradation to declare, never a sentence to trim");
  });

  it("un host degradado con herramienta la usa cuando el turno la lista, y cae a markdown cuando no", () => {
    const stamp = renderStructuredChoiceStamp(specOf("codex"));
    // El gate real (0.149.0) es la lista de tools del turno — el propio prompt de
    // codex dice "only when it is listed": cuando está listada, SE USA.
    expect(stamp).toContain("`request_user_input`");
    expect(stamp).toContain("lists it among the available tools");
    expect(stamp).toContain("present every human and authorization boundary with it");
    expect(stamp).toContain("at most 3 questions per call and 3 options each");
    // Cuando no está listada, el fallback llega con su razón accionable…
    expect(stamp).toContain("fall back to labeled markdown");
    expect(stamp).toContain("Default mode");
    expect(stamp).toContain("default_mode_request_user_input");
    // …y contrarresta el prompt del host, que ahí prefiere prosa sin opciones.
    expect(stamp).toContain("still presents every option");
  });

  it("un host sin superficie lo dice, y no toma prestado el binding de otro", () => {
    for (const id of ["warp", "oz"] as const) {
      const stamp = renderStructuredChoiceStamp(specOf(id));
      expect(stamp, id).toContain("exposes no native selection surface");
      expect(stamp, id).not.toMatch(/AskUserQuestion|request_user_input|ask_user|`question`/);
    }
  });

  it("todo stamp lleva la regla de contenido: degradar el mecanismo, nunca el contenido", () => {
    for (const spec of HARNESSES) {
      const stamp = renderStructuredChoiceStamp(spec);
      expect(stamp, spec.id).toContain("Degrade the mechanism, never the content");
      // Es un blockquote entero: se inserta en cuerpos markdown ajenos.
      for (const line of stamp.split("\n")) expect(line.startsWith("> "), spec.id).toBe(true);
    }
  });

  it("cada host recibe un stamp distinto del de los demás (si no, el estampado no estampa nada)", () => {
    const rendered = HARNESSES.map((spec) => renderStructuredChoiceStamp(spec));
    // warp y oz comparten estado pero no razón: los ocho textos son distintos.
    expect(new Set(rendered).size).toBe(HARNESSES.length);
  });

  it("un directorio compartido no nombra el mecanismo de ningún host: sería el equivocado para los demás", () => {
    const stamp = stampForInstallTarget("agents");
    expect(stamp).toContain("shared skills dir");
    expect(stamp).toContain("labeled markdown");
    expect(stamp).toContain("Harness binding matrix");
    expect(stamp).not.toMatch(/AskUserQuestion|request_user_input|ask_user/);
  });
});

// ————— la superficie realmente escrita en disco —————

function buildArgs(values: Record<string, string>): ParsedArgs {
  return {
    rest: ["install-skill"],
    plugin: {},
    flags: new Set<string>(),
    values: new Map(Object.entries(values)),
    valuesMulti: new Map(),
  };
}

function buildCtx(home: string, fs: RealFs): CliContext {
  const ns = normalizeNamespace("agent-workflow");
  const runtime: ResolvedRuntime = {
    packageName: "@tacuchi/agent-workflow-cli",
    binName: "agent-workflow",
    source: "default",
  };
  return {
    fs,
    env: new FakeEnv(home),
    process: new FakeProcess(),
    git: {} as never,
    namespace: { namespace: ns, source: "default" },
    runtime,
    paths: new PathsService(ns, home, home),
  };
}

async function seedBundle(root: string): Promise<void> {
  await mkdir(join(root, "commands"), { recursive: true });
  await mkdir(join(root, "harness"), { recursive: true });
  await writeFile(
    join(root, "SKILL.md"),
    "---\nname: w\ndescription: bundle.\n---\n\n# w\n",
    "utf8",
  );
  await writeFile(
    join(root, "commands/quick.md"),
    '---\ndescription: Lightweight shortcut.\nallowed-tools: ["Bash"]\n---\n\n# quick\n\nFollow `../loops/quick-loop/LOOP.md` with `$ARGUMENTS`.\n',
    "utf8",
  );
  await writeFile(join(root, "harness/HARNESS.md"), "# harness\n", "utf8");
}

describe("la superficie instalada lleva el binding de su host (y el bundle canónico sigue neutro)", () => {
  let workdir: string;
  let home: string;
  let source: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "aw-stamp-test-"));
    home = join(workdir, "home");
    source = join(workdir, "source");
    await mkdir(home, { recursive: true });
    await seedBundle(source);
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it("el wrapper nativo de claude lleva el stamp de claude y conserva su frontmatter", async () => {
    const fs = new RealFs();
    const result = await selfInstallSkill(
      buildArgs({ from: source, target: "claude" }),
      buildCtx(home, fs),
    );
    expect(result.ok).toBe(true);
    const wrapper = await readFile(join(home, ".claude/commands/w/quick.md"), "utf8");
    // El frontmatter de binding sobrevive intacto y el stamp entra DESPUÉS.
    expect(wrapper).toContain("allowed-tools:");
    expect(wrapper.indexOf("allowed-tools:")).toBeLessThan(
      wrapper.indexOf("Structured-choice on this host"),
    );
    expect(wrapper).toContain("(`claude`, stamped at install)");
    expect(wrapper).toContain("`AskUserQuestion`");
  });

  it("el skill-as-command sintetizado de codex lleva el stamp de codex, no el de claude", async () => {
    const fs = new RealFs();
    const result = await selfInstallSkill(
      buildArgs({ from: source, target: "codex" }),
      buildCtx(home, fs),
    );
    expect(result.ok).toBe(true);
    const skill = await readFile(join(home, ".codex/skills/w-quick/SKILL.md"), "utf8");
    expect(skill).toContain("(`codex`, stamped at install)");
    expect(skill).toContain("`request_user_input`");
    expect(skill).toContain("fall back to labeled markdown");
    expect(skill).not.toContain("`AskUserQuestion`");
  });

  it("la skill de capacidad también lleva el binding: sus `needs_input` se preguntan ahí", async () => {
    const fs = new RealFs();
    const result = await selfInstallSkill(
      buildArgs({ from: source, target: "kimi" }),
      buildCtx(home, fs),
    );
    expect(result.ok).toBe(true);
    const skill = await readFile(join(home, ".kimi-code/skills/design/SKILL.md"), "utf8");
    expect(skill).toContain("(`kimi`, stamped at install)");
    expect(skill).toContain("`AskUserQuestion`");
    expect(skill).toContain("aw capability --host kimi prepare");
  });

  it("el bundle canónico instalado NO lleva stamp: la doctrina se mantiene host-agnóstica", async () => {
    const fs = new RealFs();
    const result = await selfInstallSkill(
      buildArgs({ from: source, target: "crush" }),
      buildCtx(home, fs),
    );
    expect(result.ok).toBe(true);
    const bundled = await readFile(join(home, ".config/crush/skills/w/commands/quick.md"), "utf8");
    expect(bundled).not.toContain("Structured-choice on this host");
    // Y la fuente tampoco quedó tocada.
    expect(await readFile(join(source, "commands/quick.md"), "utf8")).not.toContain(
      "Structured-choice on this host",
    );
  });
});
