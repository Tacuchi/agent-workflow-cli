import { describe, expect, it } from "vitest";
import {
  DOCTOR_CATEGORIES,
  DOCTOR_SCHEMA_VERSION,
  type DoctorCategory,
  type DoctorCoverage,
  type DoctorCoverageState,
  type DoctorFinding,
  type DoctorFindingState,
  type DoctorRemediationKind,
  doctorFindingId,
  doctorVerdict,
  sortDoctorCoverage,
  sortDoctorFindings,
  summarizeDoctorFindings,
} from "../../src/domain/doctor/model.js";

/**
 * El modelo común del doctor: seis proveedores distintos escriben acá y una
 * sola presentación lee de acá, así que lo que este archivo congela no es
 * "código de dominio", son las tres promesas que el informe le hace al lector.
 *
 * 1. El esquema es un contrato con número: la lista de categorías y SU ORDEN
 *    son parte del formato, no una preferencia de presentación. Dos corridas
 *    sobre el mismo entorno tienen que dar informes comparables byte a byte, y
 *    un diff que reordena secciones no lo lee nadie. Por eso el orden se afirma
 *    con un literal —no derivándolo de la constante— y por eso hay una prueba
 *    que demuestra que NO es el orden alfabético: alfabéticamente
 *    `plugins-hooks` iría antes que `skills`, y el contrato lo pone último.
 *
 * 2. El orden de los hallazgos es total y no depende de en qué orden corrieron
 *    los proveedores. Un informe cuyo orden dependa del reloj de un proveedor
 *    convierte cualquier `diff` de dos corridas en ruido.
 *
 * 3. El veredicto ES el código de salida, y el defecto que este modelo existe
 *    para evitar es el peor de los seis: un doctor que devuelve 0 porque no
 *    pudo mirar. La cobertura `unavailable` sube el veredicto a 1 aunque no
 *    haya un solo hallazgo bloqueante; sin eso, un proveedor que se cae en
 *    silencio se lee como "entorno sano".
 */

/**
 * El orden del catálogo que el informe real le pasa a los ordenadores
 * (`DOCTOR_HOST_ORDER` + `"workspace"`), recortado a los hosts que usan estas
 * pruebas. Es a propósito NO alfabético: `warp` va antes que `gemini`. Ordenar
 * hosts por nombre en vez de por catálogo pasaría desapercibido con cualquier
 * subconjunto alfabético.
 */
const HOST_ORDER = ["claude-code", "warp", "gemini", "workspace"] as const;

function finding(
  host: string,
  category: DoctorCategory,
  resourceSegment: string,
  overrides: {
    state?: DoctorFindingState;
    remediation?: DoctorRemediationKind;
    resourceName?: string;
  } = {},
): DoctorFinding {
  return {
    id: doctorFindingId(host, category, resourceSegment),
    host,
    category,
    resource: {
      kind: "recurso",
      name: overrides.resourceName ?? resourceSegment,
      locator: null,
    },
    state: overrides.state ?? "healthy",
    summary: `${resourceSegment} en ${host}`,
    impact: "impacto declarado",
    evidence: [`observado en ${host}`],
    ownership: "ours",
    remediation: { kind: overrides.remediation ?? "none", action: null, guidance: [] },
  };
}

function cover(
  host: string,
  category: DoctorCategory,
  state: DoctorCoverageState = "checked",
  reason: string | null = null,
): DoctorCoverage {
  return { category, host, state, reason };
}

const idsOf = (findings: readonly DoctorFinding[]): string[] => findings.map((one) => one.id);
const slotsOf = (coverage: readonly DoctorCoverage[]): string[] =>
  coverage.map((one) => `${one.category}/${one.host}`);

describe("contrato del esquema del doctor", () => {
  it("la versión del esquema es 1", () => {
    // Un consumidor que lee el JSON discrimina por este número antes de leer
    // nada más. Subirlo sin querer (o renombrar un campo dentro de la misma
    // versión) rompe en silencio a quien ya parsea la versión 1.
    expect(DOCTOR_SCHEMA_VERSION).toBe(1);
  });

  it("las seis categorías están en el orden exacto que exige AC-02", () => {
    // El valor esperado es el literal del contrato, escrito a mano acá: si se
    // derivara de la constante la prueba sería una tautología y aprobaría
    // cualquier reordenamiento.
    expect([...DOCTOR_CATEGORIES]).toEqual([
      "installation-hosts",
      "mcps",
      "skills",
      "tools-auth",
      "plugins-hooks",
      "workspace-visibility",
    ]);
  });
});

describe("doctorFindingId", () => {
  it("compone `<host>/<categoría>/<recurso>`, no toca el recurso y lleva el host adentro", () => {
    // El id es lo que una selección nombra y lo que una re-comprobación vuelve
    // a encontrar. Los proveedores reales meten `:` dentro del segmento de
    // recurso (`dsn:alpha`, `workspace:workline`, `native:foo`): escaparlo o
    // normalizarlo dejaría los ids de una corrida sin casar con los de la
    // siguiente.
    expect(doctorFindingId("claude-code", "installation-hosts", "workline")).toBe(
      "claude-code/installation-hosts/workline",
    );
    expect(doctorFindingId("workspace", "tools-auth", "dsn:alpha")).toBe(
      "workspace/tools-auth/dsn:alpha",
    );
    // Y el host va DELANTE del resto: seis proveedores emiten el mismo nombre
    // de recurso en varios hosts a la vez (`workline`, `hooks`). Si el id no lo
    // llevara, un hallazgo pisaría al otro en cualquier mapa indexado por id.
    expect([
      doctorFindingId("claude-code", "plugins-hooks", "hooks"),
      doctorFindingId("warp", "plugins-hooks", "hooks"),
    ]).toEqual(["claude-code/plugins-hooks/hooks", "warp/plugins-hooks/hooks"]);
  });
});

describe("sortDoctorFindings", () => {
  /**
   * Lista desordenada a propósito: los hosts llegan salteados, las categorías
   * al revés del contrato y los recursos de un mismo grupo invertidos. Así
   * llega de verdad, porque cada proveedor recorre TODOS los hosts de su propia
   * categoría antes de que corra el siguiente.
   */
  const desordenados = (): DoctorFinding[] => [
    finding("gemini", "skills", "beta"),
    finding("claude-code", "plugins-hooks", "hooks"),
    finding("warp", "installation-hosts", "workline"),
    finding("claude-code", "skills", "beta"),
    finding("gemini", "installation-hosts", "workline"),
    finding("claude-code", "installation-hosts", "workline"),
    finding("claude-code", "skills", "alfa"),
    finding("warp", "tools-auth", "dsn-alpha"),
  ];

  const ESPERADO = [
    "claude-code/installation-hosts/workline",
    "claude-code/skills/alfa",
    "claude-code/skills/beta",
    "claude-code/plugins-hooks/hooks",
    "warp/installation-hosts/workline",
    "warp/tools-auth/dsn-alpha",
    "gemini/installation-hosts/workline",
    "gemini/skills/beta",
  ];

  it("agrupa por host de catálogo, después por categoría de contrato y después por recurso", () => {
    // La secuencia de arriba prueba las tres claves de una sola pasada:
    //  - `gemini` queda DESPUÉS de `warp` aunque alfabéticamente iría antes:
    //    el orden sale del catálogo que se le pasa, no del nombre.
    //  - dentro de claude-code, `skills` va antes que `plugins-hooks`, que es
    //    lo contrario del alfabético.
    //  - `alfa` antes que `beta` dentro del mismo host y categoría.
    expect(idsOf(sortDoctorFindings(desordenados(), HOST_ORDER))).toEqual(ESPERADO);
  });

  it("el tercer criterio es el NOMBRE del recurso, no el segmento del id", () => {
    // Caso real de `provider-tools-auth`: el id lleva el nombre de la conexión
    // (`dsn:alpha`) y el recurso que el lector VE es la variable de entorno
    // (`DB_ZETA_DSN`). Acá los dos ordenan al revés a propósito: por nombre de
    // recurso `DB_ALPHA_DSN` va primero (o sea `dsn:beta`), por id iría primero
    // `dsn:alpha`. Con el fixture del resto del archivo —donde el nombre del
    // recurso repite el segmento del id— la clave por recurso se puede borrar
    // del ordenador sin que nada se entere: el informe pasaría a listar por id
    // interno y no por lo que muestra la columna del recurso.
    const conexiones = [
      finding("workspace", "tools-auth", "dsn:alpha", { resourceName: "DB_ZETA_DSN" }),
      finding("workspace", "tools-auth", "dsn:beta", { resourceName: "DB_ALPHA_DSN" }),
    ];
    const porNombreDeRecurso = ["workspace/tools-auth/dsn:beta", "workspace/tools-auth/dsn:alpha"];
    expect(idsOf(sortDoctorFindings(conexiones, HOST_ORDER))).toEqual(porNombreDeRecurso);
    expect(idsOf(sortDoctorFindings([...conexiones].reverse(), HOST_ORDER))).toEqual(
      porNombreDeRecurso,
    );
  });

  it("las categorías NO se ordenan alfabéticamente", () => {
    // Alfabéticamente sería installation-hosts, mcps, plugins-hooks, skills,
    // tools-auth, workspace-visibility. El contrato pone plugins-hooks
    // ANTEÚLTIMO. Un `localeCompare` sobre la categoría —el atajo obvio— pasa
    // la prueba de arriba a medias y muere acá.
    const unSoloHost = [
      finding("claude-code", "workspace-visibility", "skills"),
      finding("claude-code", "plugins-hooks", "hooks"),
      finding("claude-code", "tools-auth", "dsn-alpha"),
      finding("claude-code", "skills", "w-plan-exec"),
      finding("claude-code", "mcps", "workspace-workline"),
      finding("claude-code", "installation-hosts", "workline"),
    ];
    expect(idsOf(sortDoctorFindings(unSoloHost, HOST_ORDER))).toEqual([
      "claude-code/installation-hosts/workline",
      "claude-code/mcps/workspace-workline",
      "claude-code/skills/w-plan-exec",
      "claude-code/tools-auth/dsn-alpha",
      "claude-code/plugins-hooks/hooks",
      "claude-code/workspace-visibility/skills",
    ]);
  });

  it("ordenar dos veces da exactamente lo mismo", () => {
    // El informe se ordena una vez sobre el consolidado, pero el ordenador se
    // usa también sobre listas ya ordenadas (un re-chequeo, un subconjunto
    // filtrado). Si no fuera idempotente, dos corridas sobre el mismo entorno
    // producirían informes que difieren sin que nada del entorno cambie.
    const unaVez = sortDoctorFindings(desordenados(), HOST_ORDER);
    const dosVeces = sortDoctorFindings(unaVez, HOST_ORDER);
    // El valor esperado sale del fixture, no de `unaVez`: comparar la segunda
    // pasada contra la primera pasaría aunque las dos estuvieran mal igual.
    expect(idsOf(unaVez)).toEqual(ESPERADO);
    expect(idsOf(dosVeces)).toEqual(ESPERADO);
  });

  it("no muta la lista que recibe", () => {
    // `report.ts` conserva la lista cruda de cada proveedor mientras acumula.
    // Un ordenamiento in situ sobre el arreglo del llamador reordenaría datos
    // que otro paso todavía está leyendo.
    const original = desordenados();
    const antes = idsOf(original);
    sortDoctorFindings(original, HOST_ORDER);
    expect(idsOf(original)).toEqual(antes);
  });

  it("un host fuera del orden de catálogo cae al final sin romper el resto", () => {
    // Pasa de verdad: `provider-tools-auth` y `provider-skills` emiten sobre el
    // pseudo-host `workspace`, y un catálogo recortado (por `--only`) puede no
    // enumerarlo. Antes que perder el hallazgo o tirar, va al final.
    const ordenParcial = ["claude-code", "warp"];
    const conDesconocido = [
      finding("workspace", "tools-auth", "dsn-alpha"),
      finding("warp", "installation-hosts", "workline"),
      finding("claude-code", "installation-hosts", "workline"),
    ];
    expect(idsOf(sortDoctorFindings(conDesconocido, ordenParcial))).toEqual([
      "claude-code/installation-hosts/workline",
      "warp/installation-hosts/workline",
      "workspace/tools-auth/dsn-alpha",
    ]);
  });

  it("dos hosts desconocidos quedan en un orden determinista, no en el de llegada", () => {
    // Los dos desconocidos empatan en rango (los dos caen al final), en
    // categoría Y en nombre de recurso: `provider-skills` emite el MISMO skill
    // en todos los hosts. O sea que ninguna de las tres primeras claves los
    // separa y el único que queda es el desempate por id. Si faltara, el
    // comparador devolvería 0 y el orden lo decidiría el de llegada: el informe
    // cambiaría según qué proveedor terminó primero. Por eso se ordena la misma
    // lista en los dos sentidos y se exige el MISMO literal en ambos.
    const ordenParcial = ["claude-code"];
    const entrada = [
      finding("workspace", "skills", "alfa"),
      finding("kimi", "skills", "alfa"),
      finding("claude-code", "skills", "alfa"),
    ];
    const esperado = ["claude-code/skills/alfa", "kimi/skills/alfa", "workspace/skills/alfa"];
    expect(idsOf(sortDoctorFindings(entrada, ordenParcial))).toEqual(esperado);
    expect(idsOf(sortDoctorFindings([...entrada].reverse(), ordenParcial))).toEqual(esperado);
  });

  it("dos hallazgos que comparten nombre de recurso se desempatan por id", () => {
    // Caso real de `provider-tools-auth`: dos conexiones distintas que declaran
    // la MISMA variable de DSN comparten `resource.name` (la variable) y sólo
    // difieren en el id (`dsn:<conexión>`). No es el caso de `provider-mcps`:
    // ahí el nombre lleva el scope pegado (`workline (user)`), así que dos
    // scopes nunca empatan. Sin el desempate por id, el orden lo decidiría el
    // de llegada y el informe cambiaría entre corridas idénticas.
    const mismaVariable = (segmento: string): DoctorFinding =>
      finding("workspace", "tools-auth", segmento, { resourceName: "DB_SHARED_DSN" });
    const entrada = [mismaVariable("dsn:zeta"), mismaVariable("dsn:alpha")];
    const esperado = ["workspace/tools-auth/dsn:alpha", "workspace/tools-auth/dsn:zeta"];
    expect(idsOf(sortDoctorFindings(entrada, HOST_ORDER))).toEqual(esperado);
    expect(idsOf(sortDoctorFindings([...entrada].reverse(), HOST_ORDER))).toEqual(esperado);
  });
});

describe("sortDoctorCoverage", () => {
  it("agrupa por categoría ANTES que por host", () => {
    // La cobertura se lee como "qué se pudo mirar de cada cosa", no como "qué
    // pasó en cada host": la sección de hosts ya existe aparte. Si esto
    // ordenara host-primero, la tabla quedaría claude-code/installation-hosts,
    // claude-code/skills, warp/installation-hosts… y responder "¿se comprobaron
    // los skills en todos lados?" exigiría recorrerla entera.
    const desordenada = [
      cover("warp", "skills", "skipped", "el usuario declinó la inspección nativa"),
      cover("claude-code", "skills"),
      cover("workspace", "tools-auth"),
      cover("warp", "installation-hosts"),
      cover("claude-code", "installation-hosts"),
    ];
    expect(slotsOf(sortDoctorCoverage(desordenada, HOST_ORDER))).toEqual([
      "installation-hosts/claude-code",
      "installation-hosts/warp",
      "skills/claude-code",
      "skills/warp",
      "tools-auth/workspace",
    ]);
  });

  it("dentro de una categoría los hosts van en orden de catálogo, y el desconocido al final", () => {
    // Mismo criterio que los hallazgos: si las dos secciones discreparan sobre
    // qué host va primero, se leen como dos entornos distintos.
    const desordenada = [
      cover("gemini", "mcps"),
      cover("kimi", "mcps", "unavailable", "no se pudo leer la config"),
      cover("claude-code", "mcps"),
      cover("warp", "mcps"),
    ];
    expect(slotsOf(sortDoctorCoverage(desordenada, HOST_ORDER))).toEqual([
      "mcps/claude-code",
      "mcps/warp",
      "mcps/gemini",
      "mcps/kimi",
    ]);
  });

  it("dos hosts desconocidos de la misma categoría se desempatan por nombre, no por llegada", () => {
    // Los dos caen al final con el MISMO rango, así que el comparador sólo se
    // salva por el desempate final `host.localeCompare`. Con un único host
    // desconocido por categoría —el fixture de la prueba de arriba— ese empate
    // no ocurre nunca y la clave se puede borrar sin una sola roja: el orden de
    // la tabla pasaría a depender de en qué orden terminaron los proveedores,
    // que es justo lo que la sección de hallazgos ya prohíbe. Se ordena en los
    // dos sentidos de llegada y se exige el mismo literal.
    const ordenParcial = ["claude-code"];
    const desordenada = [
      cover("zeta", "mcps", "unavailable", "no se pudo leer la config"),
      cover("kimi", "mcps", "unavailable", "no se pudo leer la config"),
      cover("claude-code", "mcps"),
    ];
    const esperado = ["mcps/claude-code", "mcps/kimi", "mcps/zeta"];
    expect(slotsOf(sortDoctorCoverage(desordenada, ordenParcial))).toEqual(esperado);
    expect(slotsOf(sortDoctorCoverage([...desordenada].reverse(), ordenParcial))).toEqual(esperado);
  });

  it("no muta la lista que recibe y ordenar dos veces da exactamente lo mismo", () => {
    // Mismas dos garantías que ya tienen los hallazgos, y por el mismo motivo:
    // `report.ts` acumula la cobertura cruda de cada proveedor mientras corre
    // el siguiente (un ordenamiento in situ le reordenaría datos que todavía
    // está escribiendo), y el ordenador es público, así que se lo puede llamar
    // sobre una lista ya ordenada. Dos corridas sobre el mismo entorno tienen
    // que dar la misma tabla.
    const original = [
      cover("warp", "skills", "skipped", "el usuario declinó la inspección nativa"),
      cover("claude-code", "skills"),
      cover("workspace", "tools-auth"),
      cover("claude-code", "installation-hosts"),
    ];
    const antes = slotsOf(original);
    const unaVez = sortDoctorCoverage(original, HOST_ORDER);
    expect(slotsOf(original)).toEqual(antes);
    const ESPERADO = [
      "installation-hosts/claude-code",
      "skills/claude-code",
      "skills/warp",
      "tools-auth/workspace",
    ];
    expect(slotsOf(unaVez)).toEqual(ESPERADO);
    expect(slotsOf(sortDoctorCoverage(unaVez, HOST_ORDER))).toEqual(ESPERADO);
  });
});

describe("summarizeDoctorFindings", () => {
  it("cuenta los cuatro estados y llama accionable a toda remediación que no sea `none`", () => {
    // `actionable` es lo que le dice al lector cuánto de esto tiene arreglo:
    // cuenta `supported` (automatizable) Y `manual` (con instrucciones). Contar
    // sólo `supported` escondería como "sin salida" a todo lo que sí tiene una
    // guía escrita, que es el grueso de lo que el doctor emite.
    // Las cinco cifras del fixture son DISTINTAS a propósito (3/2/1/4/5). Con
    // dos contadores que valen lo mismo, cruzar sus rótulos —contar `warning`
    // bajo `healthy` y al revés— deja la prueba verde, y el resumen es lo
    // primero que lee una persona: un cruce ahí manda a arreglar lo que estaba
    // sano y da por sano lo que bloqueaba.
    const resumen = summarizeDoctorFindings([
      finding("claude-code", "installation-hosts", "workline", { state: "healthy" }),
      finding("warp", "installation-hosts", "workline", { state: "healthy" }),
      finding("gemini", "installation-hosts", "workline", { state: "healthy" }),
      finding("claude-code", "mcps", "user:workline", {
        state: "warning",
        remediation: "manual",
      }),
      finding("workspace", "tools-auth", "dsn:alpha", { state: "warning", remediation: "manual" }),
      finding("warp", "mcps", "workspace:workline", {
        state: "blocking",
        remediation: "supported",
      }),
      finding("gemini", "skills", "w-plan-exec", {
        state: "unverified",
        remediation: "manual",
      }),
      finding("gemini", "skills", "w-quick", { state: "unverified", remediation: "manual" }),
      finding("warp", "plugins-hooks", "hooks", { state: "unverified" }),
      finding("claude-code", "workspace-visibility", "skills", { state: "unverified" }),
    ]);
    expect(resumen).toEqual({
      healthy: 3,
      warning: 2,
      blocking: 1,
      unverified: 4,
      actionable: 5,
    });
  });

  it("sin hallazgos todos los contadores son 0, y eso NO es lo mismo que sano", () => {
    // Un contador en cero no distingue "nada estaba mal" de "no se miró nada":
    // esa distinción vive en la cobertura, y el veredicto es quien la lee. Acá
    // se congela que el resumen no la inventa.
    expect(summarizeDoctorFindings([])).toEqual({
      healthy: 0,
      warning: 0,
      blocking: 0,
      unverified: 0,
      actionable: 0,
    });
  });
});

describe("doctorVerdict", () => {
  it("sale 0 sólo si no hay bloqueos y toda la cobertura quedó comprobada", () => {
    // `unverified` a nivel HALLAZGO no sube el veredicto: es un hueco concreto,
    // nombrado y con su evidencia, sobre una categoría que sí se pudo recorrer.
    // Lo que sube el veredicto es no haber podido mirar la categoría entera.
    const veredicto = doctorVerdict(
      [
        finding("claude-code", "installation-hosts", "workline", { state: "healthy" }),
        finding("warp", "mcps", "user:workline", { state: "warning", remediation: "manual" }),
        finding("gemini", "skills", "w-plan-exec", { state: "unverified" }),
      ],
      [
        cover("claude-code", "installation-hosts"),
        cover("warp", "mcps"),
        cover("gemini", "skills"),
      ],
    );
    expect(veredicto.exit_code).toBe(0);
    // El motivo del 0 es el texto que un CI muestra cuando todo salió bien, y
    // tiene que decir las DOS cosas que lo justifican: que no hubo bloqueos y
    // que ningún proveedor se cayó. `not.toBe("")` lo cumple cualquier cadena,
    // incluida la del 1.
    expect(veredicto.reason).toContain("ningún bloqueo");
    expect(veredicto.reason).toContain("ningún proveedor caído");
    expect(veredicto.reason).not.toContain("no se pudo comprobar");
  });

  it("sin ninguna fila de cobertura el veredicto es 0: la garantía NO vive acá", () => {
    // Cero filas es la forma extrema de "no se miró nada", y el modelo la
    // devuelve como sana: `unavailable` sólo puede subir el veredicto si
    // alguien declaró la ranura. Queda congelado dónde vive la garantía de
    // verdad: `report.ts` recorre los proveedores y, cuando uno tira, escribe
    // una fila `unavailable` por cada host participante (o `workspace` si no
    // quedó ninguno), así que la lista vacía no es una entrada que el informe
    // real pueda producir. Si esa emisión se perdiera, el doctor volvería a
    // salir 0 por no haber podido mirar.
    const veredicto = doctorVerdict([], []);
    expect(veredicto.exit_code).toBe(0);
    expect(veredicto.reason).toContain("ningún bloqueo");
  });

  it("con al menos un bloqueante sale 1 y el motivo NOMBRA los ids bloqueantes", () => {
    // El código de salida no alcanza: quien lo lee en un CI necesita saber cuál
    // de los hallazgos lo tumbó sin volver a parsear el informe entero. Y el
    // motivo tiene que nombrar SÓLO a los bloqueantes: meter ahí un warning
    // manda a arreglar algo que no bloqueaba nada.
    const veredicto = doctorVerdict(
      [
        finding("claude-code", "installation-hosts", "workline", { state: "blocking" }),
        finding("warp", "mcps", "user:workline", { state: "warning" }),
        finding("gemini", "plugins-hooks", "hooks", { state: "blocking" }),
      ],
      [cover("claude-code", "installation-hosts"), cover("warp", "mcps")],
    );
    expect(veredicto.exit_code).toBe(1);
    expect(veredicto.reason).toContain("claude-code/installation-hosts/workline");
    expect(veredicto.reason).toContain("gemini/plugins-hooks/hooks");
    expect(veredicto.reason).not.toContain("warp/mcps/user:workline");
    expect(veredicto.reason).toContain("2");
  });

  it("SIN un solo bloqueante, una cobertura `unavailable` sale 1 igual y nombra la categoría", () => {
    // La prueba que más importa del archivo. Un proveedor que se cae deja su
    // categoría en `unavailable`; si el veredicto mirara sólo los hallazgos,
    // devolvería 0 —no hay bloqueantes, porque no llegó a haber NADA— y quien
    // lo lee entiende "entorno sano". El 1 acá es la diferencia entre "no
    // encontré problemas" y "no pude buscarlos".
    const veredicto = doctorVerdict(
      [finding("claude-code", "installation-hosts", "workline", { state: "healthy" })],
      [
        cover("claude-code", "installation-hosts"),
        cover("claude-code", "mcps", "unavailable", "el proveedor falló: ENOENT"),
      ],
    );
    expect(veredicto.exit_code).toBe(1);
    expect(veredicto.reason).toContain("mcps");
  });

  it("la misma categoría caída en dos hosts se nombra una vez pero se cuenta dos", () => {
    // `report.ts` marca `unavailable` en TODOS los hosts participantes cuando
    // un proveedor tira, así que la lista trae repetidos. El motivo tiene que
    // decir cuántas ranuras quedaron ciegas sin escribir "mcps, mcps".
    const veredicto = doctorVerdict(
      [],
      [
        cover("claude-code", "mcps", "unavailable", "el proveedor falló: ENOENT"),
        cover("warp", "mcps", "unavailable", "el proveedor falló: ENOENT"),
      ],
    );
    expect(veredicto.exit_code).toBe(1);
    expect(veredicto.reason).toContain("2");
    expect(veredicto.reason.match(/mcps/g)).toHaveLength(1);
  });

  it("`skipped` y `not-applicable` NO alcanzan para volver el veredicto 1", () => {
    // Las dos son decisiones, no fallas: `skipped` es el usuario declinando la
    // inspección nativa y `not-applicable` es un host que no tiene esa
    // superficie. Escalarlas a 1 volvería el doctor rojo permanente y enseñaría
    // a ignorar el código de salida, que es exactamente perder la señal que
    // `unavailable` intenta dar.
    const veredicto = doctorVerdict(
      [finding("claude-code", "installation-hosts", "workline", { state: "healthy" })],
      [
        cover("claude-code", "installation-hosts"),
        cover("claude-code", "mcps", "skipped", "la inspección nativa fue declinada"),
        cover("warp", "plugins-hooks", "not-applicable", "el host no expone hooks"),
      ],
    );
    expect(veredicto.exit_code).toBe(0);
  });

  it("un bloqueante y una cobertura caída a la vez reportan el bloqueante", () => {
    // Las dos causas son motivo suficiente por separado; juntas el código sigue
    // siendo 1 (no 2, no un acumulado) y el motivo prioriza lo que sí se pudo
    // ver, que es lo accionable.
    const veredicto = doctorVerdict(
      [finding("warp", "mcps", "user:workline", { state: "blocking" })],
      [cover("claude-code", "skills", "unavailable", "el proveedor falló: EACCES")],
    );
    expect(veredicto.exit_code).toBe(1);
    expect(veredicto.reason).toContain("warp/mcps/user:workline");
  });
});
