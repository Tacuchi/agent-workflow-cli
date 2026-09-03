import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { doctorCommand } from "../../src/cli/commands/doctor.js";
import { ALL_COMMANDS } from "../../src/cli/commands/index.js";
import { sessionCloseCommand } from "../../src/cli/commands/session-close.js";
import { reviewFlags } from "../../src/cli/commands/unknown-flags.js";
import { planDispatch, resolveGlobalAlias } from "../../src/cli/dispatch-plan.js";
import { groupCommands } from "../../src/cli/help-groups.js";
import { shouldShowInteractiveMenu } from "../../src/cli/interactive-menu.js";
import { parseArgv } from "../../src/cli/parser.js";
import { CommandRegistry } from "../../src/cli/registry.js";
import { renderHumanError } from "../../src/cli/render.js";
import type { CliContext } from "../../src/cli/types.js";
import {
  DOCTOR_SCHEMA_VERSION,
  type DoctorCategory,
  type DoctorCoverage,
  type DoctorFinding,
  type DoctorHostView,
  type DoctorReport,
  doctorFindingId,
  doctorVerdict,
  sortDoctorCoverage,
  sortDoctorFindings,
  summarizeDoctorFindings,
} from "../../src/domain/doctor/model.js";
import { HARNESSES, type HarnessId } from "../../src/domain/harnesses.js";

/**
 * La SUPERFICIE de `aw doctor`: lo que se escribe en una terminal y lo que sale.
 *
 * Nada acá diagnostica nada — el informe se construye a mano y `runDoctor` está
 * doblado — porque lo que se fija son las cuatro decisiones de superficie que un
 * refactor puede deshacer sin romper ningún proveedor:
 *
 *  1. `--doctor` y `--skip-native` son booleanos EN EL PARSER. Sin eso,
 *     `consumeOptionFlag` toma como VALOR el token siguiente que no empieza con
 *     guion: `aw --doctor extra` se comía `extra` —el comando que la persona
 *     escribió— y corría el diagnóstico en vez de denunciar un comando
 *     desconocido. Un `--json` posterior nunca estuvo en riesgo, porque
 *     `consumeOptionFlag` ya rechaza un token con guion como valor.
 *  2. `--doctor` NO es flag de runtime, a propósito: con un comando explícito
 *     delante deja de ser el alias global y tiene que denunciarse como flag
 *     ajeno, no ejecutarse ni ignorarse en silencio.
 *  3. El veredicto viaja en el CÓDIGO DE SALIDA, nunca en `ok`. `main.ts` no
 *     llama a `renderHuman` cuando `ok` es `false`, así que un doctor que
 *     reportara el bloqueo como resultado fallido imprimiría una línea de error
 *     en lugar del informe entero — exactamente cuando la persona lo necesita.
 *  4. La proyección humana y el JSON hablan del MISMO informe (AC-14): los ids,
 *     las coberturas y los hosts se cuentan de los dos lados, y cada renglón se
 *     compara CONTENIDO INCLUIDO contra un bloque literal escrito acá — contar
 *     filas deja pasar un texto que miente sobre el estado de cada una.
 */

const runDoctorMock = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../../src/application/doctor/report.js", () => ({
  runDoctor: (...args: unknown[]) => runDoctorMock.run(...args),
}));

beforeEach(() => {
  // Sin esto el `mockResolvedValue` de una prueba sobrevive hacia las siguientes
  // y el orden de declaración pasa a decidir qué informe ve cada una.
  runDoctorMock.run.mockReset();
});

/** La etiqueta que el informe humano imprime sale del catálogo real, no de esta prueba. */
function hostLabel(id: HarnessId): string {
  const spec = HARNESSES.find((candidate) => candidate.id === id);
  if (spec === undefined) throw new Error(`el catálogo no declara el host ${id}`);
  return spec.label;
}

/**
 * Dos formas de host DELIBERADAMENTE opuestas: `installed` decide a la vez el
 * estado, el runtime y la instalación de Workline.
 *
 * Con dos hosts idénticos las ramas «ausente» y «sin runtime» no se renderizan
 * nunca, así que invertir `workline_installed` en producción no cambiaría una
 * sola letra del texto y ninguna prueba podría notarlo.
 */
function hostView(id: HarnessId, current: boolean, installed: boolean): DoctorHostView {
  const spec = HARNESSES.find((candidate) => candidate.id === id);
  if (spec === undefined) throw new Error(`el catálogo no declara el host ${id}`);
  return {
    host: spec.id,
    target: spec.installTarget,
    label: spec.label,
    status: installed ? "ready" : "degraded",
    current,
    runtime: installed
      ? { state: "available", version: "1.2.3" }
      : { state: "missing", version: null },
    workline_installed: installed,
  };
}

function finding(
  host: string,
  category: DoctorCategory,
  resource: string,
  state: DoctorFinding["state"],
  over: Partial<DoctorFinding> = {},
): DoctorFinding {
  return {
    id: doctorFindingId(host, category, resource),
    host,
    category,
    resource: { kind: "mcp-entry", name: resource, locator: `~/.config/${host}/${resource}` },
    state,
    summary: `${resource} quedó en estado ${state}`,
    impact: `lo que cuesta: ${resource}`,
    evidence: [`leído de ~/.config/${host}/${resource}`],
    ownership: "ours",
    remediation: { kind: "manual", action: null, guidance: [`revisá ${resource} a mano`] },
    ...over,
  };
}

function coverageOf(
  category: DoctorCategory,
  host: string,
  state: DoctorCoverage["state"],
  reason: string | null = null,
): DoctorCoverage {
  return { category, host, state, reason };
}

/**
 * El informe se ensambla con las funciones del modelo, no a mano: el resumen y
 * el veredicto los calcula producción a partir de los hallazgos, así que el
 * `exitCode` que se afirma más abajo no es un número escrito por la prueba.
 */
function reportOf(findings: DoctorFinding[], coverage: DoctorCoverage[]): DoctorReport {
  const hostOrder = [...HARNESSES.map((spec) => spec.id), "workspace"];
  const orderedFindings = sortDoctorFindings(findings, hostOrder);
  const orderedCoverage = sortDoctorCoverage(coverage, hostOrder);
  return {
    schema_version: DOCTOR_SCHEMA_VERSION,
    cli_version: "0.0.0-test",
    scope: { workspace_dir: "/w", current_host: "claude-code", only: [] },
    hosts: [hostView("claude-code", true, true), hostView("codex", false, false)],
    hosts_absent: ["kimi"],
    coverage: orderedCoverage,
    findings: orderedFindings,
    summary: summarizeDoctorFindings(orderedFindings),
    verdict: doctorVerdict(orderedFindings, orderedCoverage),
  };
}

/** Tres estados de cobertura distintos: «lo miré» no puede leerse igual que «no lo miré». */
const COVERAGE = [
  coverageOf("installation-hosts", "claude-code", "checked"),
  coverageOf("installation-hosts", "codex", "checked"),
  coverageOf("mcps", "claude-code", "checked"),
  coverageOf("mcps", "codex", "skipped", "se pidió --skip-native"),
  coverageOf("skills", "claude-code", "checked"),
  coverageOf("skills", "codex", "not-applicable", "el host no descubre skills"),
];

/**
 * Un informe con un bloqueo: el veredicto sale 1 y el comando NO puede
 * reportarlo como fallo.
 *
 * Los cuatro estados llegan con cifras DISTINTAS (3 sanos, 2 advertencias, 1
 * bloqueo, 4 no verificados) a propósito: con un hallazgo de cada uno, permutar
 * dos rótulos del resumen —lo primero que una persona lee— es invisible para
 * cualquier aserción sobre esas cifras.
 */
function blockingReport(): DoctorReport {
  return reportOf(
    [
      finding("claude-code", "installation-hosts", "runtime", "healthy"),
      finding("claude-code", "installation-hosts", "bundle", "healthy"),
      finding("claude-code", "skills", "replica", "healthy"),
      finding("claude-code", "mcps", "workline", "blocking"),
      finding("codex", "skills", "w:plan-exec", "warning"),
      finding("codex", "skills", "w:quick", "warning"),
      finding("codex", "mcps", "database", "unverified"),
      finding("codex", "mcps", "elicitation", "unverified"),
      finding("codex", "installation-hosts", "runtime", "unverified"),
      finding("codex", "installation-hosts", "hooks", "unverified"),
    ],
    COVERAGE,
  );
}

function healthyReport(): DoctorReport {
  return reportOf([finding("claude-code", "installation-hosts", "runtime", "healthy")], COVERAGE);
}

function human(report: DoctorReport): string {
  const render = doctorCommand.renderHuman;
  if (render === undefined) throw new Error("doctor perdió su proyección humana");
  return render({ ok: true, data: report, exitCode: report.verdict.exit_code }, { detail: false });
}

/** El bloque `<título> … <línea en blanco>` que el texto dedica a una sección. */
function block(text: string, heading: string): string[] {
  const lines = text.split("\n");
  const start = lines.indexOf(heading);
  if (start === -1) throw new Error(`el informe humano no tiene sección «${heading}»`);
  const end = lines.indexOf("", start);
  return lines.slice(start, end === -1 ? lines.length : end);
}

const emptyCtx = {} as unknown as CliContext;

describe("aw doctor · el parser no se come el token que sigue al alias", () => {
  // El defecto real: sin `doctor` en BOOLEAN_FLAGS, `consumeOptionFlag` toma el
  // token siguiente SIN GUION como valor. No hay riesgo con otro flag —
  // `consumeOptionFlag` ya exige `!next.startsWith("-")`— sino con el comando.
  it("`aw --doctor extra` no convierte `extra` en el valor de --doctor", () => {
    const parsed = parseArgv(["--doctor", "extra"]);
    expect(parsed.flags.has("--doctor")).toBe(true);
    expect(parsed.values.get("doctor")).toBeUndefined();
    expect(parsed.valuesMulti.has("doctor")).toBe(false);
    // `extra` queda como comando —y `aw extra` es un comando desconocido, que es
    // el error que corresponde—: lo que no puede pasar es que desaparezca y que
    // `aw --doctor extra` termine diagnosticando como si no hubiera comando.
    expect(parsed.command).toBe("extra");
  });

  it("`aw doctor --skip-native claude-code` no se traga el posicional", () => {
    const parsed = parseArgv(["doctor", "--skip-native", "claude-code"]);
    expect(parsed.flags.has("--skip-native")).toBe(true);
    expect(parsed.rest).toEqual(["claude-code"]);
    expect(parsed.values.has("skip-native")).toBe(false);
  });

  it("los flags CON valor del comando siguen tomando el suyo", () => {
    // Contracara del arreglo: pasarse de largo y declarar booleano un flag que
    // lleva valor dejaría a `--host` sin host y al informe sin el actual.
    const parsed = parseArgv(["doctor", "--host", "codex", "--only", "claude-code"]);
    expect(parsed.values.get("host")).toBe("codex");
    expect(parsed.flags.has("--host")).toBe(false);
    expect(parsed.rest).toEqual([]);
  });
});

describe("aw doctor · --doctor no es un flag de runtime", () => {
  // Se dejó FUERA de RUNTIME_FLAGS a propósito: sólo vale como alias global, sin
  // comando delante. Si estuviera ahí, cualquier comando lo toleraría en
  // silencio y `aw session-close --doctor` cerraría la sesión como si nada.
  it("un comando que no lo declara lo devuelve en unknown, y tolera los de runtime", () => {
    // LIMITACIÓN CONOCIDA, preexistente y de todo el CLI: esto fija lo que
    // `reviewFlags` responde, no lo que cada comando hace con la respuesta.
    // `status.ts` no llama a `reviewFlags` (sólo lo hacen session-close,
    // history-update y workspace-migrate), así que hoy `aw status --doctor`
    // ignora el flag EN SILENCIO. No lo introdujo el alias y no se arregla acá.
    const parsed = parseArgv(["session-close", "--code", "001", "--doctor", "--json"]);
    const review = reviewFlags(parsed, { known: ["code", "refs"] });
    expect(review.unknown).toEqual(["--doctor"]);
    expect(review.retired).toEqual([]);
  });

  it("la superficie real lo rechaza: session-close responde UNKNOWN_FLAG", async () => {
    const parsed = parseArgv(["session-close", "--code", "001", "--doctor"]);
    const result = await sessionCloseCommand.execute(parsed, emptyCtx);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("UNKNOWN_FLAG");
    expect(result.error?.message).toContain("--doctor");
  });
});

describe("aw doctor · registro y ayuda", () => {
  it("doctor vive en el grupo «Doctor / Data» y en ningún otro", () => {
    const groups = groupCommands(ALL_COMMANDS.map((command) => command.name));
    const owners = groups.filter((group) => group.commands.includes("doctor"));
    expect(owners.map((group) => group.name)).toEqual(["Doctor / Data"]);
    // El agregado compone a los doctores especializados; no los reemplaza, así
    // que tienen que seguir listados en el mismo grupo.
    expect(owners[0]?.commands).toEqual(expect.arrayContaining(["plugin-doctor", "host-doctor"]));
  });

  it("doctorCommand está registrado una sola vez y con proyección humana", () => {
    const registered = ALL_COMMANDS.filter((command) => command.name === "doctor");
    expect(registered.length).toBe(1);
    expect(registered[0]).toBe(doctorCommand);
    expect(typeof doctorCommand.renderHuman).toBe("function");
    // `aw --help` imprime el describe de cada comando: sin él el grupo lista un
    // renglón mudo. Se afirma que EXISTE, no cómo está redactado.
    expect(doctorCommand.describe?.trim()).toBeTruthy();
  });
});

describe("aw doctor · el veredicto viaja en el código de salida, no en ok", () => {
  it("con un bloqueo devuelve ok:true, exitCode 1 y el veredicto en data", async () => {
    const report = blockingReport();
    // El 1 no lo escribe la prueba: lo calcula `doctorVerdict` sobre el hallazgo
    // bloqueante que el informe lleva.
    expect(report.verdict.exit_code).toBe(1);
    expect(report.summary.blocking).toBe(1);

    runDoctorMock.run.mockResolvedValue(report);
    const result = await doctorCommand.execute(parseArgv(["doctor"]), emptyCtx);

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.data?.verdict.exit_code).toBe(1);
    expect(result.exitCode).toBe(result.data?.verdict.exit_code);
  });

  it("sin bloqueos ni cobertura caída sale 0, con el mismo ok:true", async () => {
    const report = healthyReport();
    expect(report.verdict.exit_code).toBe(0);
    runDoctorMock.run.mockResolvedValue(report);
    const result = await doctorCommand.execute(parseArgv(["doctor"]), emptyCtx);
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it("por qué: con ok:false el runtime imprimiría una línea de error en vez del informe", () => {
    const report = blockingReport();
    // `main.ts` proyecta un resultado fallido con `renderHumanError`, NUNCA con
    // el `renderHuman` del comando. Esto es lo que la persona vería si el doctor
    // reportara el bloqueo como fallo: dos líneas, cero hallazgos.
    const asFailure = renderHumanError(
      { code: "DOCTOR_BLOCKING", message: report.verdict.reason },
      report,
    );
    const text = human(report);
    expect(asFailure.trimEnd().split("\n").length).toBe(2);
    // Del bloqueo sobrevive el id porque lo nombra el motivo del veredicto; de
    // todo lo demás —los otros hallazgos, la evidencia, el impacto, la cobertura
    // y los hosts— no sobrevive nada. Las DOS direcciones, siempre: sin el
    // `toContain` positivo, borrar de `renderHuman` la línea del impacto —o la
    // de la evidencia— dejaría esta prueba verde.
    for (const item of report.findings) {
      expect(text).toContain(item.id);
      if (item.state !== "blocking") expect(asFailure).not.toContain(item.id);
      for (const evidence of item.evidence) {
        expect(text).toContain(evidence);
        expect(asFailure).not.toContain(evidence);
      }
      expect(text).toContain(`impacto: ${item.impact}`);
      expect(asFailure).not.toContain(item.impact);
    }
    expect(asFailure).not.toContain("Cobertura");
    expect(asFailure).not.toContain("Hosts");
  });

  it("sin informe la proyección humana lo dice, en vez de romper", () => {
    const render = doctorCommand.renderHuman;
    if (render === undefined) throw new Error("doctor perdió su proyección humana");
    expect(render({ ok: true, data: undefined, exitCode: 0 }, { detail: false })).toBe(
      "el diagnóstico no produjo informe.",
    );
  });

  it("traslada al informe lo que se pidió en la línea de comandos", async () => {
    runDoctorMock.run.mockResolvedValue(healthyReport());
    await doctorCommand.execute(
      parseArgv(["doctor", "--host", "codex", "--only", "claude-code", "--skip-native"]),
      emptyCtx,
    );
    expect(runDoctorMock.run).toHaveBeenCalledTimes(1);
    expect(runDoctorMock.run.mock.calls[0]?.[1]).toEqual({
      host: "codex",
      only: ["claude-code"],
      skipNative: true,
      // La autorización de verificación viaja siempre, vacía cuando nadie pidió
      // `--verify-connection`: pedir con las manos vacías es lo que hace que la
      // verificación profunda se degrade DICIÉNDOLO.
      verify: [],
    });
  });

  it("`--only` repetido no pierde hosts: restringir a dos es restringir a dos", async () => {
    // `onlyHosts` lee `valuesMulti` porque el flag se declara repetible; si el
    // parser no lo enruta ahí, la segunda ocurrencia PISA a la primera y el
    // informe sale con un host menos sin decir que recortó nada.
    runDoctorMock.run.mockResolvedValue(healthyReport());
    await doctorCommand.execute(
      parseArgv(["doctor", "--only", "claude-code", "--only", "codex"]),
      emptyCtx,
    );
    expect(runDoctorMock.run.mock.calls[0]?.[1]?.only).toEqual(["claude-code", "codex"]);
  });
});

describe("aw doctor · el texto y el JSON hablan del mismo informe (AC-14)", () => {
  it("imprime todos los hosts del informe, y sólo esos, con su marca y su instalación", () => {
    const report = blockingReport();
    const rendered = block(human(report), "Hosts");
    // Bloque literal, no derivado de la salida: la flecha del host actual y el
    // «instalado/ausente» son lo que distingue un host del otro, y contar
    // renglones los deja mentir a los dos.
    expect(rendered).toEqual([
      "Hosts",
      `→ ${hostLabel("claude-code")} · ready · runtime available 1.2.3 · Workline instalado`,
      `  ${hostLabel("codex")} · degraded · runtime missing · Workline ausente`,
      // Los ausentes se enumeran, nunca se diagnostican.
      "  sin rastro en esta máquina: kimi",
    ]);
    // Y la equivalencia con el JSON: un host de más o de menos rompe acá.
    expect(rendered.filter((line) => / · runtime /.test(line)).length).toBe(report.hosts.length);
  });

  it("imprime cada fila de cobertura con SU estado, en orden, y ninguna de más", () => {
    const report = blockingReport();
    const rendered = block(human(report), "Cobertura");
    // El estado por fila es la razón de ser del modelo de cobertura: «lo miré y
    // está bien» y «no lo miré» son respuestas distintas. Cablear un literal
    // haría que el JSON dijera `skipped` y el humano «comprobada» sobre el MISMO
    // informe. El orden —categorías del catálogo, hosts dentro de cada una— es
    // contrato: dos corridas sobre el mismo entorno son byte-comparables.
    expect(rendered).toEqual([
      "Cobertura",
      "  installation-hosts",
      "    claude-code: comprobada",
      "    codex: comprobada",
      "  mcps",
      "    claude-code: comprobada",
      "    codex: omitida — se pidió --skip-native",
      "  skills",
      "    claude-code: comprobada",
      "    codex: no aplica — el host no descubre skills",
      // Las tres categorías que este informe no trae se DECLARAN vacías en vez
      // de desaparecer: el defecto real era que un `--only` que no casaba con
      // ningún host dejaba instalación, MCPs y visibilidad sin una sola fila y
      // el texto se leía como si esas tres hubieran pasado la revisión.
      "  tools-auth",
      "    (sin cobertura declarada en esta corrida)",
      "  plugins-hooks",
      "    (sin cobertura declarada en esta corrida)",
      "  workspace-visibility",
      "    (sin cobertura declarada en esta corrida)",
    ]);
    // Ni una fila de más ni una de menos respecto del JSON.
    expect(rendered.filter((line) => /^ {4}\S+: /.test(line)).length).toBe(report.coverage.length);
  });

  it("imprime exactamente los ids de hallazgo del JSON, en las dos direcciones", () => {
    const report = blockingReport();
    const renderedIds = human(report)
      .split("\n")
      .filter((line) => /^ {2}[✔!✘?] /.test(line))
      .map((line) => line.slice(4).split(" — ")[0]);
    // Ni uno menos (un hallazgo que el JSON tiene y el texto oculta) ni uno de
    // más (un renglón que el texto inventa y nadie puede rastrear al informe).
    expect(renderedIds).toEqual([
      "claude-code/installation-hosts/bundle",
      "claude-code/installation-hosts/runtime",
      "claude-code/mcps/workline",
      "claude-code/skills/replica",
      "codex/installation-hosts/hooks",
      "codex/installation-hosts/runtime",
      "codex/mcps/database",
      "codex/mcps/elicitation",
      "codex/skills/w:plan-exec",
      "codex/skills/w:quick",
    ]);
    expect(report.findings.map((item) => item.id)).toEqual(renderedIds);
  });

  it("el resumen y el veredicto del texto son los del JSON", () => {
    const report = blockingReport();
    const text = human(report);
    // Los cinco contadores contra literales derivados del FIXTURE (3 sanos, 2
    // advertencias, 1 bloqueo, 4 no verificados y los 10 accionables porque
    // ningún hallazgo trae remediación `none`), nunca contra `report.summary`:
    // armar el esperado con la salida de producción mueve los dos lados a la vez
    // y deja pasar cualquier contador equivocado. Las cuatro cifras son
    // DISTINTAS entre sí a propósito, para que permutar dos rótulos se vea.
    expect(report.summary).toEqual({
      healthy: 3,
      warning: 2,
      blocking: 1,
      unverified: 4,
      actionable: 10,
    });
    expect(text).toContain(
      "Resumen: 3 sano · 2 advertencia · 1 bloqueo · 4 no verificado · 10 accionable",
    );
    expect(text).toContain(
      "Veredicto: salida 1 — hay 1 hallazgo(s) bloqueante(s): claude-code/mcps/workline",
    );
  });

  /**
   * AC-03: cada hallazgo declara de quién es el recurso y qué clase de arreglo
   * admite — soportado, guía manual, o ninguna acción segura.
   *
   * El defecto real que cierra: un hallazgo `manual` cuyo `guidance` vino vacío
   * —la forma que los proveedores producen cuando el motor devuelve
   * `action: null` sin texto— se imprimía renglón por renglón IDÉNTICO a uno
   * `none`. La persona leía «acá no hay nada que hacer» sobre un hallazgo que el
   * JSON marca accionable y que `summary.actionable` cuenta. La propiedad tenía
   * el mismo problema: viajaba en el JSON y del texto sólo se adivinaba de la
   * prosa del resumen (AC-08).
   */
  it("una remediación manual sin guía no se lee igual que «ninguna acción segura» (AC-03)", () => {
    const report = reportOf(
      [
        finding("claude-code", "mcps", "manual-sin-guia", "warning", {
          remediation: { kind: "manual", action: null, guidance: [] },
        }),
        finding("claude-code", "mcps", "sin-accion-segura", "warning", {
          ownership: "foreign",
          remediation: { kind: "none", action: null, guidance: [] },
        }),
      ],
      COVERAGE,
    );
    const lines = human(report).split("\n");
    /** El renglón del hallazgo y todos sus renglones sangrados. */
    const blockOf = (id: string): string[] => {
      const start = lines.findIndex((line) => line.includes(`${id} — `));
      if (start === -1) throw new Error(`el texto no imprimió el hallazgo ${id}`);
      const rest = lines.slice(start + 1);
      const end = rest.findIndex((line) => !line.startsWith("      "));
      return [lines[start] as string, ...(end === -1 ? rest : rest.slice(0, end))];
    };

    // Los dos bloques COMPLETOS: sin el renglón de propiedad y remediación, los
    // dos hallazgos salen letra por letra iguales salvo por su nombre, y la
    // prueba no podría distinguir «hay algo que hacer» de «no hay nada seguro».
    expect(blockOf("claude-code/mcps/manual-sin-guia")).toEqual([
      "  ! claude-code/mcps/manual-sin-guia — manual-sin-guia quedó en estado warning",
      "      impacto: lo que cuesta: manual-sin-guia",
      "      evidencia: leído de ~/.config/claude-code/manual-sin-guia",
      "      propiedad: de Workline · remediación: manual",
    ]);
    expect(blockOf("claude-code/mcps/sin-accion-segura")).toEqual([
      "  ! claude-code/mcps/sin-accion-segura — sin-accion-segura quedó en estado warning",
      "      impacto: lo que cuesta: sin-accion-segura",
      "      evidencia: leído de ~/.config/claude-code/sin-accion-segura",
      "      propiedad: ajena · remediación: sin acción segura",
    ]);

    // La equivalencia con el JSON, sobre el informe grande: un renglón por
    // hallazgo, ni uno menos (un hallazgo que no declara nada) ni uno de más.
    const big = blockingReport();
    const declared = human(big)
      .split("\n")
      .filter((line) => line.startsWith("      propiedad: "));
    expect(declared).toHaveLength(big.findings.length);
  });
});

/** La raíz del checkout, derivada del propio archivo: `import.meta.url` es una
 *  URL y convertirla con `fileURLToPath` es lo único que soporta una ruta con
 *  espacios o `#`. Interpolarla a mano dentro de `new URL()` no. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("aw doctor · la proyección humana no puede ser forjada desde un archivo ajeno", () => {
  /**
   * Casi todo lo que el informe imprime nació en un archivo que escribió otra
   * persona: el nombre de una entrada MCP, el motivo que el host reportó, la URL
   * de una skill. Una clave JSON admite saltos de línea, y el texto se une con
   * `\n`: sin aplanar cada línea, una entrada llamada `"inocente\n  ✔ …"`
   * imprime un renglón de hallazgo que NINGÚN hallazgo produjo — tapando uno
   * real o inventando un veredicto.
   *
   * El saneo vive acá y NO en el id a propósito: los hallazgos se indexan por
   * id, así que sanear la identidad hacía colapsar dos entradas distintas en una
   * y la otra desaparecía del informe.
   */
  it("un nombre con saltos de línea no agrega renglones de hallazgo al texto", () => {
    const forjado =
      "inocente\n  ✔ claude-code/mcps/workspace:qtc-cert — la conexión está sana\n      impacto: ninguno";
    const report = reportOf(
      [
        {
          id: doctorFindingId("claude-code", "mcps", `workspace:${forjado}`),
          host: "claude-code",
          category: "mcps",
          resource: { kind: "mcp-entry", name: forjado, locator: "~/.mcp.json" },
          state: "warning",
          summary: `${forjado} es una entrada ajena con problemas`,
          impact: "lo que cuesta:\n  ✘ codex/mcps/native:x — cae",
          evidence: ["archivo:\n  ! warp/skills/y — falta"],
          ownership: "foreign",
          remediation: { kind: "manual", action: null, guidance: ["revisá\n  ✔ falso — sano"] },
        },
      ],
      COVERAGE,
    );

    const text = human(report);
    // UN solo renglón de hallazgo, el que el informe realmente tiene.
    const rows = text.split("\n").filter((line) => /^ {2}[✔!✘?] /.test(line));
    expect(rows).toHaveLength(1);
    // Y ninguna de las líneas forjadas aparece como renglón propio.
    expect(text).not.toContain("la conexión está sana\n");
    expect(
      text.split("\n").filter((line) => line.trim() === "✘ codex/mcps/native:x — cae"),
    ).toEqual([]);
    // El nombre sigue ahí, legible y en una sola línea.
    expect(text).toContain("inocente");
  });
});

describe("aw doctor · el alias global se intercepta antes del menú", () => {
  const registry = new CommandRegistry();
  for (const command of ALL_COMMANDS) registry.register(command);

  function planFor(argv: string[], isTTY: boolean, hasHelp = false) {
    const parsed = parseArgv(argv);
    return planDispatch({ command: parsed.command, flags: parsed.flags, isTTY, hasHelp });
  }

  it("`aw --doctor` en una TTY despacha el comando doctor y NO abre el menú", () => {
    // El corazón del punto: para esta entrada exacta el predicado del menú sigue
    // diciendo `true`, así que un alias consultado DESPUÉS de esa línea abriría
    // la TUI y el diagnóstico no correría nunca. El orden vive dentro de
    // `planDispatch`, así que moverlo, borrarlo o resolver otro comando son tres
    // cosas que esta prueba ve.
    const parsed = parseArgv(["--doctor"]);
    expect(
      shouldShowInteractiveMenu({ command: parsed.command, isTTY: true, hasHelp: false }),
    ).toBe(true);

    expect(planFor(["--doctor"], true)).toEqual({ kind: "command", name: "doctor", help: false });
  });

  it("el nombre que el plan devuelve resuelve al comando doctor en el registro real", () => {
    const plan = planFor(["--doctor"], true);
    if (plan.kind !== "command") throw new Error("se esperaba un despacho a comando");
    expect(registry.resolve(plan.name)).toBe(doctorCommand);
  });

  it("`aw --doctor --json` sigue siendo el alias y conserva la proyección pedida", () => {
    const parsed = parseArgv(["--doctor", "--json"]);
    expect(
      resolveGlobalAlias({
        command: parsed.command,
        flags: parsed.flags,
        isTTY: true,
        hasHelp: false,
      }),
    ).toBe("doctor");
    // El alias corre `doctor`, pero la salida la elige `--json`: si el parser
    // enterrara ese flag, el informe saldría en modo humano justo cuando lo que
    // se pidió era la salida para máquina.
    expect(parsed.flags.has("--json")).toBe(true);
  });

  it("`aw --doctor --help` despacha el doctor pidiendo SU ayuda, no la global", () => {
    expect(planFor(["--doctor"], true, true)).toEqual({
      kind: "command",
      name: "doctor",
      help: true,
    });
  });

  it("con un comando explícito el alias no aplica: `aw status --doctor` despacha status", () => {
    expect(planFor(["status", "--doctor"], true)).toEqual({
      kind: "command",
      name: "status",
      help: false,
    });
  });

  it("sin el flag la decisión es la de siempre: menú en TTY, ayuda global fuera de ella", () => {
    expect(planFor([], true)).toEqual({ kind: "menu" });
    expect(planFor([], false)).toEqual({ kind: "global-help" });
    expect(planFor(["--json"], true)).toEqual({ kind: "menu" });
  });

  it("el despachador ejecuta el plan y no elige comandos por su cuenta", () => {
    // La mitad que una función pura no puede probar: que `main.ts` resuelva el
    // nombre QUE EL PLAN LE DA. Un literal ahí —`registry.resolve("status")`—
    // dejaría a `aw --doctor` corriendo otra cosa con toda la lógica de arriba
    // intacta. Es una aserción sobre la forma del código, a propósito, porque
    // `main.ts` corre el CLI al importarse y no hay otra manera de mirarlo.
    const main = readFileSync(join(REPO_ROOT, "src", "cli", "main.ts"), "utf8");
    expect(main).toContain("registry.resolve(plan.name)");
    expect(main).not.toMatch(/registry\.resolve\("/);
  });
});

/**
 * AC-04: la fase diagnóstica se completa SIN ninguna escritura durable, y eso
 * incluye la bitácora del CLI.
 *
 * `main.ts` corre el CLI al importarse, así que su cableado sólo puede mirarse
 * como texto — la misma razón, y el mismo precedente, que la aserción sobre
 * `registry.resolve(plan.name)`. Lo que se fija no es un detalle de estilo: con
 * el logger habilitado, cada `aw doctor` creaba `~/.workflow/logs/` y le anexaba
 * DOS renglones (la invocación con su argv completa y el resultado con su código
 * de salida), así que la promesa central del lote era falsa en la superficie
 * real aunque ningún proveedor escribiera un solo byte.
 */
describe("aw doctor · el diagnóstico no escribe ni siquiera la bitácora (AC-04)", () => {
  const main = readFileSync(join(REPO_ROOT, "src", "cli", "main.ts"), "utf8");

  it("doctor es comando de sólo lectura estricta, y el predicado gobierna el logger", () => {
    const predicate = /function isStrictReadCommand\([\s\S]*?\n}/.exec(main)?.[0];
    if (predicate === undefined) throw new Error("main.ts ya no declara isStrictReadCommand");
    const exempt = [...predicate.matchAll(/"([a-z-]+)"/g)].map((match) => match[1]).sort();
    expect(exempt).toEqual(["doctor", "resume", "status"]);
    // Y el predicado sigue siendo el que apaga la bitácora: declararlo sin
    // cablearlo dejaría las dos escrituras intactas.
    expect(main).toMatch(/new Logger\(\{[^}]*enabled: !isStrictReadCommand\(/);
  });

  it("el alias global también queda exento: `aw --doctor` llega sin comando", () => {
    // La otra mitad del defecto: para esta entrada exacta —la que la spec pinta
    // como «corrélo a ciegas»— `parsed.command` es `undefined`, así que juzgar
    // ese campo a secas dejaba al alias con la bitácora encendida. El comando
    // efectivo lo resuelve el mismo alias que despacha.
    const parsed = parseArgv(["--doctor"]);
    expect(parsed.command).toBeUndefined();
    expect(
      resolveGlobalAlias({
        command: parsed.command,
        flags: parsed.flags,
        isTTY: false,
        hasHelp: false,
      }),
    ).toBe("doctor");

    const predicate = /function isStrictReadCommand\([\s\S]*?\n}/.exec(main)?.[0];
    expect(predicate).toContain("effectiveCommandName(parsed)");
    const effective = /function effectiveCommandName\([\s\S]*?\n}/.exec(main)?.[0];
    expect(effective).toContain("resolveGlobalAlias");
  });

  it("la exención es del INFORME: con un subverbo la bitácora vuelve a encenderse", () => {
    // El defecto que atrapa: eximir por nombre de comando dejaba sin rastro
    // justamente las dos invocaciones que hay que poder auditar después —
    // `apply`, que reescribe la configuración de los hosts y corre programas, y
    // `prepare`, que produce el digest que autoriza eso—. El informe sí promete
    // no escribir nada; sus subverbos no prometen eso en absoluto.
    const predicate = /function isStrictReadCommand\([\s\S]*?\n}/.exec(main)?.[0];
    if (predicate === undefined) throw new Error("main.ts ya no declara isStrictReadCommand");
    expect(predicate).toContain("parsed.rest.length === 0");

    // Y el parser deja el subverbo donde el predicado lo mira.
    expect(parseArgv(["doctor"]).rest).toEqual([]);
    expect(parseArgv(["doctor", "apply", "--approval", "abc"]).rest).toEqual(["apply"]);
    expect(parseArgv(["doctor", "prepare", "--select", "x"]).rest).toEqual(["prepare"]);
  });
});
