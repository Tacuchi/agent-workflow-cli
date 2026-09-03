import { describe, expect, it } from "vitest";
import { annotateRepairs } from "../../src/application/doctor/actions.js";
import {
  EFFECT_CLASSES,
  type EffectClass,
  SELF_AUTHORIZABLE_CLASSES,
} from "../../src/domain/capability/effects.js";
import type {
  DoctorCategory,
  DoctorFinding,
  DoctorFindingState,
  DoctorOwnership,
  DoctorRepairHint,
} from "../../src/domain/doctor/model.js";
import { doctorFindingId } from "../../src/domain/doctor/model.js";
import {
  DOCTOR_OPERATIONS,
  type DoctorOperationSpec,
  doctorOperation,
} from "../../src/domain/doctor/operations.js";

/**
 * El catálogo de reparaciones y el gate de propiedad: las dos piezas de F3 que
 * deciden QUIÉN puede ser modificado y CON QUÉ autorización.
 *
 * Las dos existen por la misma razón y se rompen del mismo modo silencioso. El
 * catálogo promete que recomendar no es autorizar: una operación que se colara
 * con sólo clases auto-autorizables correría sin que nadie diga sí, y el informe
 * seguiría viéndose igual. El gate promete que sólo se escribe sobre recursos
 * atribuibles a Workline: un hallazgo ajeno que recibiera acción produciría un
 * lote perfectamente sellado que pisa el archivo de otra persona, y ninguna
 * prueba del sellado lo notaría porque el sello sella lo que le dan.
 *
 * Por eso las aserciones de acá van sobre el catálogo ENTERO y sobre TODOS los
 * hallazgos de la corrida, no sobre las entradas que alguien eligió mirar: una
 * regla que se comprueba en la entrada de ejemplo es una regla que se rompe en
 * la entrada número doce.
 */

/**
 * El catálogo ENTERO, congelado a mano.
 *
 * Es la única defensa contra un movimiento silencioso dentro del tramo no
 * auto-autorizable: declarar `mutate_overwrite` («reescribe») lo que en realidad
 * BORRA deja la aprobación mostrando un efecto más chico que el real, y una
 * prueba que sólo exija «alguna clase no auto-autorizable» no lo nota. Lo mismo
 * con `expected`: hoy las once declaran `healthy`, así que cualquier aserción
 * derivada del catálogo es indistinguible de un literal, y la primera entrada
 * que espere otra cosa pasaría sin que nadie lo decida.
 *
 * Cada fila lleva también el módulo y el símbolo exacto del delegado —el par, no
 * la unión de exports— y el verbo compuesto con argumentos como los que los
 * proveedores emiten de verdad (`target`, `host`/`instance`/`scope`, `name`).
 *
 * Se escribe a mano y se compara contra el catálogo. Cuando una entrada cambia
 * de verdad, esta tabla se actualiza con la mano de alguien que decidió el
 * cambio: es el punto donde el cambio se aprueba.
 */
interface CatalogRow {
  op: string;
  /** Dónde vive el delegado y cómo se llama. El par, atado. */
  module: string;
  delegates: string;
  effects: readonly EffectClass[];
  expected: DoctorFindingState;
  /** Argumentos realistas para el verbo, y el verbo exacto que compone. */
  args: Record<string, string>;
  verb: string;
}

const CATALOG: readonly CatalogRow[] = [
  {
    op: "self.install-skill",
    module: "../../src/application/self/install-skill.js",
    delegates: "selfInstallSkill",
    effects: ["local_additive", "mutate_overwrite"],
    expected: "healthy",
    args: { target: "claude" },
    verb: "aw self install-skill --target claude",
  },
  {
    op: "self.uninstall",
    module: "../../src/application/self/uninstall.js",
    delegates: "selfUninstall",
    // BORRA. No es `mutate_overwrite`: retirar no es reescribir, y la persona
    // aprueba lo que le muestran.
    effects: ["destructive"],
    expected: "healthy",
    args: { target: "codex" },
    verb: "aw self uninstall --target codex",
  },
  {
    op: "self.install-hooks",
    module: "../../src/application/self/install-hooks.js",
    delegates: "selfInstallHooks",
    effects: ["mutate_overwrite"],
    expected: "healthy",
    args: { target: "claude" },
    verb: "aw self install-hooks --target claude",
  },
  {
    op: "self.clean-legacy",
    module: "../../src/application/self/clean-legacy.js",
    delegates: "selfCleanLegacy",
    effects: ["destructive"],
    expected: "healthy",
    args: { target: "gemini" },
    verb: "aw self clean-legacy --target gemini",
  },
  {
    op: "mcp.setup",
    module: "../../src/application/mcp-setup-service.js",
    delegates: "runMcpSetup",
    effects: ["mutate_overwrite"],
    expected: "healthy",
    args: { host: "claude", instance: "cert", scope: "workspace" },
    verb: "aw mcp setup --host claude --instance cert --scope workspace",
  },
  {
    op: "mcp.remove",
    module: "../../src/application/mcp-remove-service.js",
    delegates: "runMcpRemove",
    effects: ["destructive"],
    expected: "healthy",
    args: { host: "codex", instance: "prod", scope: "user" },
    verb: "aw mcp remove --host codex --instance prod --scope user",
  },
  {
    op: "mcp.migrate",
    module: "../../src/application/mcp-migration-service.js",
    delegates: "runMcpMigration",
    // Mueve Y retira la vieja: las dos clases, en ese orden.
    effects: ["mutate_overwrite", "destructive"],
    expected: "healthy",
    args: { host: "claude", instance: "agent-workflow", scope: "user" },
    verb: "aw mcp migrate --host claude --instance agent-workflow --scope user",
  },
  {
    op: "skills.reinstall",
    module: "../../src/application/self/skills-manager.js",
    delegates: "reinstallSkill",
    effects: ["mutate_overwrite"],
    expected: "healthy",
    args: { name: "w:doctor" },
    verb: "aw self skills reinstall --name w:doctor",
  },
  {
    op: "auth.flow",
    module: "../../src/application/doctor/auth-flow.js",
    delegates: "runDoctorAuthFlow",
    // `execute` y nada más de este lado. Lo que el flujo además necesite lo
    // declara el flujo, y el anotador lo SUMA antes de sellar: acá se congela lo
    // que la operación pide por sí misma, que es correr un programa.
    effects: ["execute"],
    expected: "healthy",
    args: { provider: "dsn", subject: "env:qtc-cert" },
    // Los dos nombres van parentizados a propósito: el id del único proveedor
    // real es `dsn`, y sin los paréntesis el redactor se lleva la palabra que
    // sigue («por dsn *** env:qtc-cert»).
    verb: "el flujo declarado por el proveedor (dsn) para el sujeto (env:qtc-cert)",
  },
  {
    op: "multiroot.attach",
    module: "../../src/application/multiroot-service.js",
    delegates: "runMultiroot",
    effects: ["mutate_overwrite"],
    expected: "healthy",
    // El verbo no lleva los argumentos: `--from-sources` los deriva del
    // workspace. Congelarlo es lo que impide que aparezca un `--scope user`
    // inventado en la vista previa.
    args: { scope: "user" },
    verb: "aw attach-multiroot --from-sources",
  },
  {
    op: "multiroot.detach",
    module: "../../src/application/multiroot-service.js",
    delegates: "runMultiroot",
    effects: ["mutate_overwrite"],
    expected: "healthy",
    args: { scope: "user" },
    verb: "aw detach-multiroot --from-sources",
  },
];

/** Los módulos que la tabla nombra, sin repetir: uno por import. */
const DELEGATE_MODULES: readonly string[] = [...new Set(CATALOG.map((row) => row.module))];

/** La línea que el proveedor de MCPs escribe al oler un secreto pegado en `env`. */
const EMBEDDED_CREDENTIAL_EVIDENCE = "la entrada contiene algo con forma de credencial embebida";

/**
 * Un hallazgo con todo puesto para ser accionable, y un solo campo movido por
 * prueba.
 *
 * El molde arranca ELEGIBLE a propósito: cada caso del gate cambia exactamente
 * la cosa que debería descalificarlo, así que una prueba roja señala ese campo y
 * no una combinación de tres.
 */
function finding(overrides: Partial<DoctorFinding> = {}): DoctorFinding {
  return {
    id: doctorFindingId("claude-code", "mcps", "qtc-cert"),
    host: "claude-code",
    category: "mcps",
    resource: { kind: "mcp-entry", name: "qtc-cert", locator: "~/.claude.json" },
    state: "blocking",
    summary: "la conexión registrada no tiene entrada en el archivo del host",
    impact: "el agente de ese host no puede consultar esa base",
    evidence: ["la entrada no aparece en el archivo del host"],
    ownership: "ours",
    remediation: { kind: "manual", action: null, guidance: [] },
    proposal: { op: "mcp.setup", args: { host: "claude", instance: "cert", scope: "workspace" } },
    ...overrides,
  };
}

/** Un hallazgo propio y accionable de la categoría y el host que se le pidan. */
function actionable(
  id: string,
  host: string,
  category: DoctorCategory,
  proposal: DoctorRepairHint,
): DoctorFinding {
  return finding({ id, host, category, proposal });
}

const only = (findings: readonly DoctorFinding[]): DoctorFinding => {
  expect(findings).toHaveLength(1);
  return findings[0] as DoctorFinding;
};

describe("catálogo de operaciones de reparación", () => {
  it("ninguna entrada del catálogo se autoriza sola", () => {
    // El agujero que atrapa: una operación nueva declarada sólo con clases
    // auto-autorizables (`read_only`/`local_additive`) se aplicaría sin que
    // nadie la apruebe, y el catálogo dejaría de separar recomendar de
    // autorizar sin cambiar nada visible en el informe. Se juzga contra
    // `SELF_AUTHORIZABLE_CLASSES` —la constante del contrato de capacidades—
    // porque una lista copiada acá dejaría de moverse cuando esa se mueva.
    const selfAuthorizable: ReadonlySet<string> = new Set(SELF_AUTHORIZABLE_CLASSES);
    const escaped = DOCTOR_OPERATIONS.filter(
      (spec) => !spec.effects.some((effect) => !selfAuthorizable.has(effect)),
    ).map((spec) => spec.op);

    // Se afirma la PROPIEDAD contra la constante del contrato y nada más. Antes
    // había además un predicado `requiresApproval(spec)` en el dominio del
    // doctor, y se retiró: era una segunda implementación de la regla que
    // `decision-preview.ts` ya calcula con esta misma constante, no tenía ningún
    // llamador en producción, y un `return true` la dejaba pasar. Lo que sí
    // consulta el producto es `batch.requires_approval`, que `prepare` publica.
    expect(escaped).toEqual([]);
  });

  it("las clases de efecto y el estado esperado de cada operación son los de la tabla congelada", () => {
    // El defecto que atrapa: dentro del tramo no auto-autorizable una operación
    // se puede mover libremente sin romper nada. `self.uninstall` declarado
    // `mutate_overwrite` en vez de `destructive` sigue exigiendo aprobación,
    // sigue siendo del vocabulario cerrado y sigue teniendo una clase: lo único
    // que cambia es que la pantalla donde la persona dice sí anuncia «reescribe»
    // sobre algo que BORRA. Por eso la comparación es contra literales escritos
    // a mano y no contra el propio catálogo.
    expect(DOCTOR_OPERATIONS.map((spec) => spec.op).sort()).toEqual(
      CATALOG.map((row) => row.op).sort(),
    );

    for (const row of CATALOG) {
      const spec = doctorOperation(row.op);
      expect(spec, `${row.op} no está en el catálogo`).not.toBeNull();
      expect(
        spec === null ? null : [...spec.effects],
        `${row.op} cambió sus clases de efecto`,
      ).toEqual([...row.effects]);
      expect(spec?.expected, `${row.op} cambió su estado esperado`).toBe(row.expected);
    }
  });

  it("toda clase de efecto declarada pertenece al vocabulario cerrado y ninguna lista está vacía", () => {
    // El defecto que atrapa: una clase inventada («write», «install») o un typo
    // pasan silenciosos porque nada las valida en runtime, y el lote termina
    // pidiendo aprobación de un efecto que la política del host no sabe negar.
    // Una lista vacía es peor: es una operación que escribe declarando que no
    // hace nada.
    const vocabulary: ReadonlySet<string> = new Set(EFFECT_CLASSES);
    for (const spec of DOCTOR_OPERATIONS) {
      expect(spec.effects.length, `la operación ${spec.op} no declara efectos`).toBeGreaterThan(0);
      for (const effect of spec.effects) {
        expect(vocabulary.has(effect), `${spec.op} declara la clase ajena '${effect}'`).toBe(true);
      }
    }
  });

  it("los ids son únicos y cada uno resuelve; uno inexistente devuelve null", () => {
    // El defecto que atrapa: dos entradas con el mismo `op` dejan una
    // INALCANZABLE —el índice se queda con la última— y la selección de un lote
    // aplicaría la operación equivocada con el id correcto.
    const ids = DOCTOR_OPERATIONS.map((spec) => spec.op);
    expect(new Set(ids).size).toBe(ids.length);

    for (const spec of DOCTOR_OPERATIONS) {
      expect(doctorOperation(spec.op)).toBe(spec);
    }
    // Y un id que nadie declara no puede resolver a la primera entrada del
    // catálogo por descuido: eso convertiría una sugerencia sin respaldo en una
    // reparación destructiva.
    expect(doctorOperation("self.install-skill-typo")).toBeNull();
    expect(doctorOperation("")).toBeNull();
  });

  it("cada operación delega en el símbolo EXACTO de su módulo, y es una función", async () => {
    // El defecto que atrapa: `delegates` es lo único que ata una operación a su
    // única implementación, y es una CADENA. Un renombre en la capa de
    // aplicación —o un typo al agregar una entrada— deja el catálogo nombrando
    // una función que no existe, y eso no se descubre hasta el momento de
    // aplicar, con la aprobación ya dada. Y se juzga PAR por PAR: contra la
    // unión de los exports de los diez módulos, `skills.reinstall` podría
    // apuntar a `selfUninstall` —que existe, y borra— y pasar.
    const exportsByModule = new Map<string, Record<string, unknown>>();
    for (const path of DELEGATE_MODULES) {
      exportsByModule.set(path, (await import(path)) as Record<string, unknown>);
    }

    for (const row of CATALOG) {
      expect(doctorOperation(row.op)?.delegates, `${row.op} delega en otra función`).toBe(
        row.delegates,
      );
      const mod = exportsByModule.get(row.module) as Record<string, unknown>;
      // El símbolo tiene que ser invocable: un `type` o una constante homónima
      // satisfaría la búsqueda por nombre sin poder aplicar nada.
      expect(
        typeof mod[row.delegates],
        `${row.module} no exporta la función ${row.delegates}`,
      ).toBe("function");
    }
  });

  it("`verb()` compone el comando exacto de cada operación con argumentos reales", () => {
    // El defecto que atrapa: el verbo es el texto que la persona copia a su
    // terminal para hacerlo con su propia autorización, y también la guía que
    // recibe un recurso ajeno. Un verbo al que le falte `--host/--instance/--scope`
    // sigue siendo no vacío y sigue sin decir `undefined` —«aw mcp remove» a
    // secas pasa cualquier prueba de forma— y le borra a la persona una entrada
    // que no era la que quería. Por eso los diez van contra un literal.
    for (const row of CATALOG) {
      const spec = doctorOperation(row.op);
      expect(spec?.verb(row.args), `${row.op} compone otro verbo`).toBe(row.verb);
    }
  });

  it("`verb()` con argumentos faltantes no revienta ni deja `undefined` a la vista", () => {
    // El defecto que atrapa: la vista previa se deriva del objeto sellado y se
    // compone para TODAS las operaciones del lote. Una que tire —o que muestre
    // `undefined`— rompe la única pantalla donde la persona decide si aprueba.
    for (const spec of DOCTOR_OPERATIONS) {
      const shown = spec.verb({});
      expect(shown.length, `${spec.op} compone un verbo vacío`).toBeGreaterThan(0);
      expect(shown, `${spec.op} muestra un argumento sin resolver`).not.toContain("undefined");
    }
  });

  it("cada operación declara un resumen y un estado esperado", () => {
    // El defecto que atrapa: una entrada sin `summary` deja una línea muda en la
    // vista previa —«se va a hacer algo en este host»— y un `expected` fuera del
    // vocabulario de estados hace que la recomprobación posterior nunca pueda
    // confirmar nada.
    const states: readonly DoctorFindingState[] = ["healthy", "warning", "blocking", "unverified"];
    for (const spec of DOCTOR_OPERATIONS) {
      expect(spec.summary.length, `${spec.op} no tiene resumen`).toBeGreaterThan(0);
      expect(states, `${spec.op} espera un estado que no existe`).toContain(spec.expected);
    }
  });
});

describe("gate de propiedad al anotar reparaciones", () => {
  const NOT_OURS: readonly DoctorOwnership[] = ["foreign", "ambiguous", "n/a"];

  for (const ownership of NOT_OURS) {
    it(`un hallazgo '${ownership}' con sugerencia no recibe acción ni queda 'supported'`, () => {
      // El defecto que atrapa: es la promesa entera de AC-08. El proveedor de
      // MCPs diagnostica TODO el archivo del host, propios y ajenos, así que una
      // sugerencia sobre una entrada ajena existe de verdad en la corrida. Si el
      // gate la deja pasar, el lote reescribe la configuración MCP de otra
      // persona con una aprobación que decía «reparar mi entorno».
      const result = only(annotateRepairs([finding({ ownership })]));
      expect(result.remediation.kind).toBe("manual");
      expect(result.remediation.action).toBeNull();
    });
  }

  it("un hallazgo que su proveedor ya marcó 'supported' se degrada a 'manual' al ser rechazado", () => {
    // El defecto que atrapa: es la forma EXACTA en que AC-08 se filtraría. El
    // molde de estas pruebas llega con `kind: "manual"`, así que todas las
    // aserciones de arriba se cumplirían igual si el gate no normalizara nada:
    // las cumple el fixture. Un proveedor que emitiera `supported` —por copiar
    // otro proveedor, o por un `remediation` armado antes de conocer la
    // propiedad— dejaría el informe publicando «esto tiene reparación
    // soportada» sobre un recurso ajeno, con la acción en null y un cliente
    // leyendo el `kind` para decidir si lo ofrece.
    const result = only(
      annotateRepairs([
        finding({
          ownership: "foreign",
          remediation: { kind: "supported", action: null, guidance: [] },
        }),
      ]),
    );
    expect(result.remediation.kind).toBe("manual");
    expect(result.remediation.action).toBeNull();
  });

  it("un rechazado que su proveedor marcó 'none' conserva 'none' aunque haya sugerido algo", () => {
    // El defecto que atrapa: normalizar todo rechazo a 'manual' borra la
    // distinción que el proveedor decidió. 'none' es «no hay nada seguro que
    // hacer acá», y convertirlo en 'manual' promete instrucciones sobre un
    // recurso que el proveedor declaró intocable.
    const result = only(
      annotateRepairs([
        finding({
          ownership: "ambiguous",
          remediation: { kind: "none", action: null, guidance: [] },
        }),
      ]),
    );
    expect(result.remediation.kind).toBe("none");
    expect(result.remediation.action).toBeNull();
  });

  it("un hallazgo propio cuya evidencia menciona la credencial embebida sólo recibe guía", () => {
    // El defecto que atrapa: la propiedad y el secreto son cosas distintas. Una
    // entrada con la forma que Workline publica pero con una credencial pegada
    // en `env` clasifica 'ours', y repararla automáticamente significaría
    // reescribir el archivo que guarda ese secreto —moverlo, copiarlo o
    // perderlo— en vez de pedir que la persona lo rote.
    const result = only(
      annotateRepairs([
        finding({
          ownership: "ours",
          evidence: ["la entrada coincide con una forma publicada", EMBEDDED_CREDENTIAL_EVIDENCE],
        }),
      ]),
    );
    expect(result.ownership).toBe("ours");
    expect(result.remediation.kind).toBe("manual");
    expect(result.remediation.action).toBeNull();
  });

  it("la categoría 'tools-auth' nunca recibe acción, ni siendo propia ni con sugerencia", () => {
    // El defecto que atrapa: automatizarla obligaría al CLI a ESCRIBIR el valor
    // de la variable DSN en algún lado, y con eso la custodia del secreto pasa a
    // ser suya. Es la única categoría excluida por decisión y no por omisión, y
    // una exclusión por decisión es la primera que alguien «arregla» al ver un
    // hallazgo propio sin acción.
    const result = only(
      annotateRepairs([
        finding({
          id: doctorFindingId("claude-code", "tools-auth", "DB_QTC_CERT_DSN"),
          category: "tools-auth",
          ownership: "ours",
          resource: { kind: "connection", name: "qtc-cert", locator: "DB_QTC_CERT_DSN" },
          proposal: { op: "mcp.setup", args: { host: "claude", instance: "cert" } },
        }),
      ]),
    );
    expect(result.remediation.kind).toBe("manual");
    expect(result.remediation.action).toBeNull();
  });

  it("un hallazgo sano no recibe acción aunque traiga sugerencia", () => {
    // El defecto que atrapa: `healthy` se EMITE, así que la corrida está llena
    // de hallazgos sanos. Accionarlos convierte un lote de dos reparaciones en
    // uno de veinte reescrituras idempotentes-en-teoría sobre archivos que no
    // tenían nada mal.
    const result = only(annotateRepairs([finding({ state: "healthy" })]));
    expect(result.remediation.kind).not.toBe("supported");
    expect(result.remediation.action).toBeNull();
  });

  // Los tres estados que SÍ se reparan. Es una lista escrita a mano: la del
  // anotador es un `Set` privado y reducirla a `["blocking"]` no rompería
  // ninguna aserción sobre el molde —que llega `blocking`— mientras el doctor
  // dejaría de reparar lo único que los proveedores reales emiten, porque todos
  // sus hallazgos accionables salen con `warning`.
  const REPAIRABLE: readonly DoctorFindingState[] = ["warning", "blocking", "unverified"];

  for (const state of REPAIRABLE) {
    it(`un hallazgo propio '${state}' recibe la acción con las clases de efecto DEL CATÁLOGO`, () => {
      // El defecto que atrapa: el anotador podría declarar las clases de efecto
      // por su cuenta —o dejarlas vacías— y entonces la aprobación mostraría un
      // efecto más chico que el que la operación realmente hace. `mcp.migrate`
      // mueve y BORRA: las dos clases congeladas acá vienen del contrato, no de
      // la salida del anotador.
      const result = only(
        annotateRepairs([
          finding({
            state,
            proposal: {
              op: "mcp.migrate",
              args: { host: "claude", instance: "cert", scope: "workspace" },
            },
          }),
        ]),
      );
      expect(result.remediation.kind).toBe("supported");
      expect(result.remediation.action).toEqual({
        op: "mcp.migrate",
        args: { host: "claude", instance: "cert", scope: "workspace" },
        effects: ["mutate_overwrite", "destructive"],
        depends_on: [],
        expected: "healthy",
      });
    });
  }

  it("la guía que el proveedor escribió sobrevive a la acción soportada", () => {
    // El defecto que atrapa: los hallazgos accionables de verdad LLEGAN con
    // guía —el proveedor de MCPs emite `driftGuidance` y además la sugerencia—,
    // y la rama que otorga la acción reescribe `remediation`. Si armara el
    // objeto desde cero (`{ kind, action }`), el informe perdería el texto que
    // explica qué pasó, y quedaría una reparación sin ninguna frase que la
    // acompañe justo donde la persona decide si la aprueba. Todas las demás
    // aserciones de guía de este archivo son sobre RECHAZADOS: ninguna cubría
    // este caso.
    const guidance = [
      "la entrada de ese host no coincide con la forma que Workline publica",
      "aw mcp setup --host claude --instance cert --scope workspace",
    ];
    const result = only(
      annotateRepairs([
        finding({
          state: "warning",
          remediation: { kind: "manual", action: null, guidance },
        }),
      ]),
    );
    expect(result.remediation.kind).toBe("supported");
    expect(result.remediation.action).not.toBeNull();
    expect(result.remediation.guidance).toEqual(guidance);
  });

  it("para toda operación del catálogo la acción copia sus efectos y su estado esperado", () => {
    // El defecto que atrapa: la aserción anterior fija UNA operación. Acá se
    // recorre el catálogo entero, porque una divergencia entre lo que el
    // catálogo declara y lo que la acción lleva sólo aparece en la entrada que
    // nadie eligió mirar — y es la que decide qué aprueba la persona.
    for (const spec of DOCTOR_OPERATIONS) {
      const result = only(
        annotateRepairs([finding({ proposal: { op: spec.op, args: { target: "user" } } })]),
      );
      const action = result.remediation.action;
      expect(action, `${spec.op} no produjo acción`).not.toBeNull();
      expect(action?.effects, `${spec.op} no lleva los efectos del catálogo`).toEqual([
        ...spec.effects,
      ]);
      expect(action?.expected, `${spec.op} no lleva el estado esperado del catálogo`).toBe(
        spec.expected,
      );
      expect(action?.op).toBe(spec.op);
    }
  });

  it("armar hooks depende de instalar el bundle cuando las dos acciones entran a la corrida", () => {
    // El defecto que atrapa: armar los hooks escribe DENTRO de la configuración
    // que instalar el bundle crea. Sin la dependencia declarada, el orden
    // topológico del lote es libre y la mitad de las corridas arma hooks sobre
    // un bundle que todavía no existe.
    const install = actionable(
      doctorFindingId("claude-code", "installation-hosts", "bundle"),
      "claude-code",
      "installation-hosts",
      { op: "self.install-skill", args: { target: "user" } },
    );
    const hooks = actionable(
      doctorFindingId("claude-code", "plugins-hooks", "hooks"),
      "claude-code",
      "plugins-hooks",
      { op: "self.install-hooks", args: { target: "user" } },
    );

    const [annotatedInstall, annotatedHooks] = annotateRepairs([install, hooks]);
    expect(annotatedInstall?.remediation.action?.depends_on).toEqual([]);
    expect(annotatedHooks?.remediation.action?.depends_on).toEqual([install.id]);
  });

  it("sin instalación en la corrida, `depends_on` de los hooks queda vacío", () => {
    // El defecto que atrapa: una dependencia que nombra un id que nadie va a
    // ejecutar bloquea esa acción PARA SIEMPRE — el ejecutor espera un éxito que
    // no puede llegar. Por eso `depends_on` se resuelve entre las acciones de
    // ESTA corrida y no contra el catálogo.
    const hooks = actionable(
      doctorFindingId("claude-code", "plugins-hooks", "hooks"),
      "claude-code",
      "plugins-hooks",
      { op: "self.install-hooks", args: { target: "user" } },
    );
    const result = only(annotateRepairs([hooks]));
    expect(result.remediation.kind).toBe("supported");
    expect(result.remediation.action?.depends_on).toEqual([]);
  });

  it("la instalación de OTRO host no se convierte en dependencia de estos hooks", () => {
    // El defecto que atrapa: la dependencia es por host. Tomar «la primera
    // instalación de la corrida» hace que los hooks de codex esperen a que se
    // instale el bundle de claude-code, que es una espera que nada resuelve y un
    // orden que nadie pidió.
    const installElsewhere = actionable(
      doctorFindingId("codex", "installation-hosts", "bundle"),
      "codex",
      "installation-hosts",
      { op: "self.install-skill", args: { target: "user" } },
    );
    const hooks = actionable(
      doctorFindingId("claude-code", "plugins-hooks", "hooks"),
      "claude-code",
      "plugins-hooks",
      { op: "self.install-hooks", args: { target: "user" } },
    );

    const annotated = annotateRepairs([installElsewhere, hooks]);
    const annotatedHooks = annotated.find((entry) => entry.id === hooks.id);
    expect(annotatedHooks?.remediation.action?.depends_on).toEqual([]);
  });

  it("con dos hosts que instalan y arman hooks, cada hooks depende del install DE SU host", () => {
    // El defecto que atrapa: con un solo par install+hooks en la corrida,
    // emparejar por host y emparejar por posición dan el MISMO resultado. La
    // corrida real trae los ocho hosts, y un emparejamiento por índice —o «la
    // primera instalación elegible»— hace que los hooks de codex esperen a que
    // se instale el bundle de claude-code: un orden que nadie pidió y una espera
    // que el ejecutor resuelve armando hooks sobre el host equivocado.
    const installClaude = actionable(
      doctorFindingId("claude-code", "installation-hosts", "bundle"),
      "claude-code",
      "installation-hosts",
      { op: "self.install-skill", args: { target: "claude" } },
    );
    const hooksClaude = actionable(
      doctorFindingId("claude-code", "plugins-hooks", "hooks"),
      "claude-code",
      "plugins-hooks",
      { op: "self.install-hooks", args: { target: "claude" } },
    );
    const installCodex = actionable(
      doctorFindingId("codex", "installation-hosts", "bundle"),
      "codex",
      "installation-hosts",
      { op: "self.install-skill", args: { target: "codex" } },
    );
    const hooksCodex = actionable(
      doctorFindingId("codex", "plugins-hooks", "hooks"),
      "codex",
      "plugins-hooks",
      { op: "self.install-hooks", args: { target: "codex" } },
    );

    // El orden de entrada cruza los pares a propósito: los dos installs
    // primero y los hooks al revés. Con install+hooks intercalados por host, un
    // emparejamiento por índice acierta por casualidad y la prueba no distingue
    // nada.
    const annotated = annotateRepairs([installClaude, installCodex, hooksCodex, hooksClaude]);
    const dependsOf = (id: string): readonly string[] | undefined =>
      annotated.find((entry) => entry.id === id)?.remediation.action?.depends_on;

    expect(dependsOf(installClaude.id)).toEqual([]);
    expect(dependsOf(installCodex.id)).toEqual([]);
    expect(dependsOf(hooksClaude.id)).toEqual(["claude-code/installation-hosts/bundle"]);
    expect(dependsOf(hooksCodex.id)).toEqual(["codex/installation-hosts/bundle"]);
  });

  it("una instalación no elegible no se nombra como dependencia", () => {
    // El defecto que atrapa: si el mapa de instalaciones se armara sobre TODOS
    // los hallazgos y no sólo sobre los elegibles, los hooks dependerían de una
    // instalación que el gate descartó por ajena — otra espera para siempre,
    // esta vez nacida del propio gate.
    const foreignInstall = finding({
      id: doctorFindingId("claude-code", "installation-hosts", "bundle"),
      category: "installation-hosts",
      ownership: "foreign",
      proposal: { op: "self.install-skill", args: { target: "user" } },
    });
    const hooks = actionable(
      doctorFindingId("claude-code", "plugins-hooks", "hooks"),
      "claude-code",
      "plugins-hooks",
      { op: "self.install-hooks", args: { target: "user" } },
    );

    const annotated = annotateRepairs([foreignInstall, hooks]);
    expect(
      annotated.find((entry) => entry.id === foreignInstall.id)?.remediation.action,
    ).toBeNull();
    expect(
      annotated.find((entry) => entry.id === hooks.id)?.remediation.action?.depends_on,
    ).toEqual([]);
  });

  it("el campo interno `proposal` no sobrevive a la anotación", () => {
    // El defecto que atrapa: `proposal` es la sugerencia del proveedor y el
    // informe emitido no la publica. Si sobreviviera, el esquema tendría dos
    // lugares que dicen qué reparar —uno aprobado y otro no— y un cliente que
    // leyera el equivocado ejecutaría lo que el gate rechazó.
    const annotated = annotateRepairs([
      finding(),
      finding({ id: "claude-code/mcps/ajeno", ownership: "foreign" }),
      finding({ id: "claude-code/mcps/sano", state: "healthy" }),
      finding({ id: "claude-code/mcps/sin-sugerencia", proposal: undefined }),
    ]);
    expect(annotated).toHaveLength(4);
    for (const entry of annotated) {
      // `Object.hasOwn` y no `=== undefined`: la clave presente con valor
      // `undefined` sobrevive a `JSON.stringify` como ausente pero el esquema
      // igual la declara, y es la forma en que el campo interno «se retira» sin
      // retirarse.
      expect(Object.hasOwn(entry, "proposal"), `${entry.id} conserva 'proposal'`).toBe(false);
    }
  });

  it("una sugerencia que nombra una operación inexistente se degrada a guía manual", () => {
    // El defecto que atrapa: el catálogo es la autoridad sobre qué se puede
    // ejecutar. Una sugerencia sin especificación no tiene clases de efecto que
    // aprobar, así que fabricarle una acción produciría un lote que pide
    // autorización para un efecto que nadie declaró — o un `TypeError` en medio
    // del informe.
    const result = only(
      annotateRepairs([finding({ proposal: { op: "mcp.teleport", args: { host: "claude" } } })]),
    );
    expect(result.remediation.kind).toBe("manual");
    expect(result.remediation.action).toBeNull();
  });

  it("un hallazgo sin sugerencia conserva su remediación 'none' y no gana guía", () => {
    // El defecto que atrapa: «no hay nada seguro que hacer» y «hay que hacerlo a
    // mano» son respuestas distintas, y el proveedor es el que sabe cuál es.
    // Degradar todo a 'manual' inventa una instrucción que nadie escribió.
    const result = only(
      annotateRepairs([
        finding({
          proposal: undefined,
          remediation: { kind: "none", action: null, guidance: [] },
        }),
      ]),
    );
    expect(result.remediation.kind).toBe("none");
    expect(result.remediation.guidance).toEqual([]);
    expect(result.remediation.action).toBeNull();
  });

  it("un ajeno sin guía propia recibe como guía el verbo del catálogo, sin acción", () => {
    // El defecto que atrapa: negar la acción y no decir nada deja a la persona
    // con un hallazgo bloqueante y ninguna salida. El verbo compuesto es
    // justamente el texto que puede tipear ella misma, con su propia
    // autorización sobre su propio recurso.
    // El esperado es un LITERAL. Escribirlo como `[spec.verb(args)]` calculaba
    // el esperado con la misma función que se está juzgando: un verbo mutilado
    // —`aw mcp remove` sin host ni instancia— habría pasado a la guía y a esta
    // aserción a la vez.
    const args = { host: "claude", instance: "cert", scope: "user" };
    const result = only(
      annotateRepairs([finding({ ownership: "foreign", proposal: { op: "mcp.remove", args } })]),
    );
    expect(result.remediation.action).toBeNull();
    expect(result.remediation.guidance).toEqual([
      "aw mcp remove --host claude --instance cert --scope user",
    ]);
  });

  it("la guía que el proveedor ya escribió no se pisa", () => {
    // El defecto que atrapa: el proveedor conoce el detalle («rotá esa
    // credencial») y el catálogo sólo conoce el comando. Reemplazar la guía por
    // el verbo perdería la única instrucción que importa en el caso del secreto.
    const guidance = ["retirá el valor de `env` y rotá esa credencial"];
    const result = only(
      annotateRepairs([
        finding({
          ownership: "foreign",
          evidence: [EMBEDDED_CREDENTIAL_EVIDENCE],
          remediation: { kind: "manual", action: null, guidance },
        }),
      ]),
    );
    expect(result.remediation.guidance).toEqual(guidance);
  });

  it("el gate no reordena ni pierde hallazgos, y devuelve uno por cada entrada", () => {
    // El defecto que atrapa: el orden estable del informe se aplica DESPUÉS de
    // anotar. Un anotador que filtrara los no accionables borraría del informe
    // exactamente los hallazgos ajenos que el doctor existe para mostrar.
    const input = [
      finding({ id: "claude-code/mcps/a" }),
      finding({ id: "claude-code/mcps/b", ownership: "foreign" }),
      finding({ id: "codex/mcps/c", host: "codex", state: "healthy" }),
    ];
    const annotated = annotateRepairs(input);
    expect(annotated.map((entry) => entry.id)).toEqual(input.map((entry) => entry.id));
  });

  it("los efectos y los argumentos de la acción no comparten identidad con el catálogo ni con la sugerencia", () => {
    // El defecto que atrapa: devolver `spec.effects` o `hint.args` por
    // referencia deja que cualquier consumidor del lote —el ejecutor, el
    // renderizador— mute el catálogo del proceso entero. La siguiente corrida
    // aprobaría clases de efecto distintas de las declaradas.
    const hint: DoctorRepairHint = { op: "mcp.setup", args: { host: "claude" } };
    const spec = doctorOperation("mcp.setup") as DoctorOperationSpec;
    const result = only(annotateRepairs([finding({ proposal: hint })]));
    const action = result.remediation.action;
    expect(action?.effects).not.toBe(spec.effects);
    expect(action?.args).not.toBe(hint.args);
    (action?.effects as EffectClass[]).push("read_only");
    expect([...spec.effects]).toEqual(["mutate_overwrite"]);
  });
});
