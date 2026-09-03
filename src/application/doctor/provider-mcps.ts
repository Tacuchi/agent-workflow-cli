/**
 * MCPs — the drift of our own connections, every entry each host holds, and
 * what the host itself says about them.
 *
 * Three reads because there are three different questions, and answering only
 * the first is what makes today's `mcp doctor` blind to the MCP that is broken
 * on this machine without being Workline's. Ownership decides what may be
 * ACTED on, never what may be reported: an entry nobody here wrote still costs
 * the person a working host when it fails, so it is diagnosed and given
 * written guidance, and never an action.
 */
import {
  type DoctorFinding,
  type DoctorRepairHint,
  doctorFindingId,
} from "../../domain/doctor/model.js";
import { type McpDriftReport, type McpHost, mcpEntryNameFor } from "../../domain/mcp-entry.js";
import { WORKLINE_MCP_ENTRY_NAME, worklineMcpEntry } from "../../domain/workline-mcp-entry.js";
import { readMcpConnections } from "../mcp-connections-service.js";
import { hasEmbeddedCredential, runMcpDoctor } from "../mcp-doctor-service.js";
import { classifyMcpEntry } from "../mcp-entry-classification.js";
import { readMcpEntry, scanMcpEntries } from "../mcp-host-reader.js";
import {
  NATIVE_MCP_HOSTS,
  type NativeHostDeps,
  type NativeMcpHost,
  type NativeMcpServerState,
  type NativeReadFailure,
  readNativeMcpState,
} from "./native-host-state.js";
import type { DoctorProvider, DoctorProviderInput, DoctorProviderOutput } from "./types.js";
import { coverage } from "./types.js";

const CATEGORY = "mcps" as const;
const SCOPES = ["workspace", "global"] as const;
type Scope = (typeof SCOPES)[number];

export interface McpsProviderDeps {
  native?: NativeHostDeps;
}

export function createMcpsProvider(deps: McpsProviderDeps = {}): DoctorProvider {
  return {
    category: CATEGORY,
    async run(input: DoctorProviderInput): Promise<DoctorProviderOutput> {
      // No early return for "no host takes MCP by file": with an empty list every
      // loop below produces nothing and `coverageFor` already answers
      // `not-applicable` per host, so a guard here would be a second spelling of
      // the same answer — and the kind of branch no test can tell apart.
      const hosts = input.hosts.filter((host) => host.mcp_host !== null);
      const configured = await configuredEntries(input, hosts);
      const findings = configured.findings;

      const native: NativeMerge = input.skipNative
        ? { findings: [], failures: new Map() }
        : nativeFindings(hosts, configured.owners, deps.native ?? {});
      for (const finding of native.findings) findings.set(finding.id, finding);

      return {
        coverage: input.hosts.map((host) =>
          coverageFor(
            host,
            input.skipNative,
            native.failures,
            configured.unreadable.get(host.host) ?? [],
          ),
        ),
        findings: [...findings.values()],
      };
    },
  };
}

interface ConfiguredEntries {
  findings: Map<string, DoctorFinding>;
  /**
   * Dueño por host + nombre REAL de la entrada, llevado desde donde se emitió.
   *
   * Antes el cruce con el veredicto nativo recuperaba ese nombre des-renderizando
   * con una expresión regular la etiqueta que se le muestra a la persona
   * (`nombre (scope)`), y eso ataba la PROPIEDAD al formato de presentación: hoy
   * esa etiqueta va saneada —sin controles y con techo de largo—, así que ya no
   * se puede volver desde ella al nombre que el host escribió. Si el cruce falla,
   * un MCP propio que el host no logra conectar baja de bloqueante a advertencia
   * ajena en silencio.
   */
  owners: Map<string, DoctorFinding>;
  /** Archivos que existen y no decodifican, por host. */
  unreadable: Map<string, string[]>;
}

/** Los dos productores que leen ARCHIVOS: el registro de conexiones y el barrido del host. */
async function configuredEntries(
  input: DoctorProviderInput,
  hosts: readonly DoctorProviderInput["hosts"][number][],
): Promise<ConfiguredEntries> {
  const findings = new Map<string, DoctorFinding>();
  const owners = new Map<string, DoctorFinding>();
  const unreadable = new Map<string, string[]>();
  const connections = readMcpConnections(input.ctx.paths, input.ctx.env);
  const ourNames = new Set(connections.map((connection) => mcpEntryNameFor(connection.name)));
  const mcpHosts = hosts.map((host) => host.mcp_host as McpHost);
  // Primero gana: los dos scopes emiten un hallazgo por el mismo nombre y
  // `workspace` se recorre antes, que es el orden que el cruce tenía.
  const remember = (finding: DoctorFinding, entryName: string): void => {
    findings.set(finding.id, finding);
    const key = ownerKey(finding.host, entryName);
    if (!owners.has(key)) owners.set(key, finding);
  };

  for (const scope of SCOPES) {
    for (const report of driftReports(input, mcpHosts, connections, scope)) {
      // `runMcpDoctor` reports by MCP host id (`claude`) and the report is
      // keyed by catalog id (`claude-code`). Emitting the engine's id here
      // split one host into two rows AND — worse — made `nativeFindings`
      // never recognize its own connection as ours, so a Workline MCP the
      // host cannot connect came back as somebody else's warning instead of
      // the blocking finding the spec promises.
      remember(ownConnectionFinding(report, catalogHostOf(hosts, report.host)), report.instance);
    }
    const swept = await fileEntryFindings(input, hosts, scope, ourNames);
    for (const entry of swept.entries) remember(entry.finding, entry.entryName);
    for (const [host, targets] of swept.unreadable) {
      unreadable.set(host, [...(unreadable.get(host) ?? []), ...targets]);
    }
  }
  return { findings, owners, unreadable };
}

/** Host + nombre tal como el archivo lo escribió: la clave del cruce, nunca la etiqueta. */
function ownerKey(host: string, entryName: string): string {
  return `${host}\u0000${entryName}`;
}

/** The catalog id for an MCP host id, falling back to the engine's own id. */
function catalogHostOf(
  hosts: readonly DoctorProviderInput["hosts"][number][],
  mcpHost: string,
): string {
  return hosts.find((candidate) => candidate.mcp_host === mcpHost)?.host ?? mcpHost;
}

// Sin conexiones registradas el motor devuelve cero reportes por su propia
// construcción (un doble bucle hosts × conexiones), así que una guarda acá sería
// la segunda forma de escribir la misma respuesta: la rama que ninguna prueba
// puede distinguir, igual que la que este archivo ya se niega a agregar arriba.
function driftReports(
  input: DoctorProviderInput,
  hosts: McpHost[],
  connections: ReturnType<typeof readMcpConnections>,
  scope: Scope,
): McpDriftReport[] {
  const doctor = runMcpDoctor(input.ctx.env, input.ctx.paths, {
    scope,
    workspace: input.workspaceDir,
    hosts,
    connections,
  });
  return doctor.reports;
}

/**
 * One of our own connections, as `runMcpDoctor` already judged it.
 *
 * The status vocabulary is not re-derived here — that engine owns the eight
 * drift states — only translated. `ok` emits its healthy finding rather than
 * being dropped, because "the report showed nothing about qtc-cert" and "qtc-cert
 * is fine" have to be different lines.
 */
function ownConnectionFinding(report: McpDriftReport, host: string): DoctorFinding {
  const id = doctorFindingId(host, CATEGORY, `${report.scope}:${report.instance}`);
  const base = {
    id,
    host,
    category: CATEGORY,
    resource: {
      kind: "mcp-entry" as const,
      name: `${report.instance} (${report.scope})`,
      locator: report.target,
    },
    evidence: driftEvidence(report),
  };
  if (report.status === "ok") {
    return {
      ...base,
      state: "healthy",
      summary: `la conexión ${report.instance} está registrada y coincide en ${host}`,
      impact: "el host puede levantar este MCP con la configuración vigente",
      ownership: "ours",
      remediation: { kind: "none", action: null, guidance: [] },
    };
  }
  if (report.entry_state === "foreign") {
    return {
      ...base,
      state: "warning",
      summary: `${report.instance} existe en ${host} con una forma que no es la de Workline`,
      impact: "Workline no puede tocarla: reemplazarla borraría configuración de otra persona",
      ownership: "foreign",
      remediation: {
        kind: "manual",
        action: null,
        guidance: [`revisá ${report.target} y decidí a mano si esa entrada debe quedar`],
      },
    };
  }
  const repair = driftRepair(report);
  return {
    ...base,
    state: "warning",
    summary: driftSummary(report, host),
    impact: "el host no levantará este MCP como Workline lo dejó configurado",
    ownership: "ours",
    remediation: { kind: "manual", action: null, guidance: driftGuidance(report) },
    ...(repair === null ? {} : { proposal: repair }),
  };
}

/**
 * Qué operación arregla cada clase de drift — y cuáles no tienen ninguna.
 *
 * Los dos estados de la variable DSN no aparecen acá a propósito: su remedio es
 * que la persona exporte la variable, y el CLI no puede hacerlo sin custodiar el
 * valor. El resto se mapea a la operación que ya escribe esa configuración.
 */
function driftRepair(report: McpDriftReport): DoctorRepairHint | null {
  const args = { host: report.host, instance: report.instance, scope: report.scope };
  switch (report.status) {
    case "missing-mcp":
      return { op: "mcp.setup", args };
    case "legacy-entry":
      // La entrada quedó con una forma anterior EN SU LUGAR: se reescribe donde
      // está. Mover una entrada de la ubicación histórica es otra operación, y la
      // decide el descriptor de abajo, que es el que sabe de qué archivo salió.
      return { op: "mcp.setup", args };
    case "extra-entry":
      return { op: "mcp.remove", args };
    default:
      return null;
  }
}

/**
 * El nombre de una variable, escrito de la única forma que sobrevive al informe.
 *
 * Todo el informe pasa por `redactSensitiveValue`, que trata `…DSN` seguido de
 * `=`, `:` o UN ESPACIO como una asignación y reemplaza la palabra siguiente por
 * `***`. Sobre una negación eso no oscurece: MIENTE. «DB_X_DSN no está en …»
 * sale como «DB_X_DSN *** está en …», que afirma exactamente lo contrario de lo
 * observado; y una guía «export DB_X_DSN=***» copiada tal cual deja esa basura
 * en el `.zshenv` de la persona y hace que el doctor declare sana para siempre
 * una conexión que no puede autenticarse.
 *
 * El paréntesis de cierre no es un separador, así que `(DB_X_DSN)` atraviesa el
 * redactor entero. Es la misma defensa que el proveedor de tools-auth documenta
 * en su evidencia, y acá cubre las tres superficies: evidencia, resumen y guía.
 */
function named(variable: string): string {
  return `(${variable})`;
}

/**
 * La evidencia de un drift se COMPONE acá; el `detail` del motor sólo se refleja
 * blindado.
 *
 * Ese texto lo escribe `runMcpDoctor`, que lo comparte con `aw mcp doctor` y no
 * se puede tocar desde este informe: nombra la variable de DSN en medio de una
 * frase («MCP 'x' registrado pero DB_X_DSN no está en …»), que es justo la forma
 * que el redactor invierte. Se blinda cada mención antes de emitirla.
 */
function driftEvidence(report: McpDriftReport): string[] {
  return [
    `estado de la entrada: ${report.entry_state}`,
    `drift: ${report.status}`,
    ...(report.detail === undefined ? [] : [shieldVariables(report.detail, report.dsn.key)]),
  ];
}

/**
 * Toda mención de una variable de entorno, entre paréntesis.
 *
 * Dos pasadas porque el motor la nombra de dos maneras: entera
 * (`DB_QTC_CERT_DSN`) y como la palabra suelta `DSN` («Ni DSN ni MCP
 * registrados»). La segunda no toca lo ya blindado: dentro de `(DB_X_DSN)` la
 * `DSN` va precedida de `_`, que es carácter de palabra, así que `\bDSN\b` no
 * casa ahí.
 */
function shieldVariables(text: string, key: string): string {
  return text
    .split(key)
    .join(named(key))
    .replace(/\bDSN\b/g, named("DSN"));
}

// Prose names the host by its CATALOG id, so it reads the same as the `host`
// field beside it. Guidance keeps the ENGINE id, because `aw mcp setup --host`
// takes `claude`, not `claude-code`: the two ids are not interchangeable and the
// difference is exactly which one a person is about to type.
function driftSummary(report: McpDriftReport, host: string): string {
  switch (report.status) {
    case "missing-mcp":
      return `falta la entrada de ${report.instance} en ${host}`;
    case "dsn-mismatch":
      return `${report.instance} está en ${host} pero su variable ${named(report.dsn.key)} no coincide`;
    case "missing-dsn":
      return `${report.instance} no tiene visible su variable ${named(report.dsn.key)}`;
    case "extra-entry":
      return `${host} tiene una entrada de ${report.instance} que ya no está registrada`;
    case "legacy-entry":
      return `${report.instance} en ${host} quedó con la forma de una versión anterior`;
    case "malformed-entry":
      return `la entrada de ${report.instance} en ${host} no se puede decodificar`;
    default:
      return `${report.instance} en ${host}: ${report.status}`;
  }
}

function driftGuidance(report: McpDriftReport): string[] {
  switch (report.status) {
    case "missing-mcp":
    case "legacy-entry":
      return [`aw mcp setup --host ${report.host} --instance ${report.instance}`];
    case "extra-entry":
      return [`aw mcp remove --host ${report.host} --instance ${report.instance}`];
    case "missing-dsn":
    case "dsn-mismatch":
      return [`exportá la variable ${named(report.dsn.key)} y volvé a registrar la conexión`];
    default:
      return [`revisá ${report.target}`];
  }
}

/**
 * Every OTHER entry the host holds — the half no existing doctor looks at.
 *
 * Not registered here means not ours: the ownership predicates compare the whole
 * generated shape, and there is no shape to compare against for a server nobody
 * registered. So these findings never carry an action, only what can be observed
 * about them: whether they decode, whether their binary resolves, and whether
 * somebody pasted a credential into the file.
 */
interface EntryFinding {
  finding: DoctorFinding;
  /** El nombre tal como el host lo tiene escrito, no la etiqueta que se muestra. */
  entryName: string;
}

interface FileSweep {
  entries: EntryFinding[];
  /** Archivos que existen y no decodifican, por host: no se miró nada adentro. */
  unreadable: Map<string, string[]>;
}

async function fileEntryFindings(
  input: DoctorProviderInput,
  hosts: readonly DoctorProviderInput["hosts"][number][],
  scope: Scope,
  ourNames: ReadonlySet<string>,
): Promise<FileSweep> {
  const scopeDir = scope === "global" ? input.ctx.env.homeDir() : input.workspaceDir;
  const entries: EntryFinding[] = [];
  const unreadable = new Map<string, string[]>();
  for (const host of hosts) {
    const mcpHost = host.mcp_host as McpHost;
    const scan = scanMcpEntries(mcpHost, scopeDir, scope);
    // Un archivo que no decodifica no declara CERO entradas: no declara ninguna
    // que se haya podido leer. La diferencia es la cobertura entera de este host.
    if (scan.unreadable.length > 0) unreadable.set(host.host, scan.unreadable);
    for (const name of scan.names) {
      if (ourNames.has(name)) continue;
      const snapshot = readMcpEntry(mcpHost, scopeDir, name, scope);
      // Workline's own elicitation descriptor is not a registered DB connection,
      // so the connection registry does not know it — and calling it foreign
      // would tell the person their own install belongs to somebody else.
      if (name === WORKLINE_MCP_ENTRY_NAME) {
        entries.push({
          finding: worklineEntryFinding(host.host, mcpHost, scope, snapshot),
          entryName: name,
        });
        continue;
      }
      const problems = await entryProblems(input, snapshot);
      entries.push({
        finding: foreignEntryFinding(host.host, scope, name, snapshot, problems),
        entryName: name,
      });
    }
  }
  return { entries, unreadable };
}

/**
 * What can be observed about an entry nobody registered here.
 *
 * Three questions and no verdict: whether it decodes, whether somebody pasted a
 * credential into the file, and whether its binary resolves anywhere. Ownership
 * is decided elsewhere and is never inferred from these.
 */
async function entryProblems(
  input: DoctorProviderInput,
  snapshot: ReturnType<typeof readMcpEntry>,
): Promise<string[]> {
  const problems: string[] = [];
  // `malformed` lo decide el lector, y hasta este lote sólo se le preguntaba por
  // las entradas stdio de Workline: una entrada REMOTA legítima —`{type:"http"|
  // "sse", url}`, el caso normal y no el borde— no tiene `command` y salía
  // reportada como «no tiene la forma de un servidor MCP decodificable», con un
  // impacto («el host puede fallar al levantarla») que describe un problema que
  // no existe. El lector ya distingue las dos formas; acá sólo se lo consulta.
  if (snapshot.malformed === true || (snapshot.exists === false && snapshot.present === true)) {
    problems.push("la entrada no tiene la forma de un servidor MCP decodificable");
  }
  if (hasEmbeddedCredential(snapshot)) {
    problems.push("la entrada contiene algo con forma de credencial embebida");
  }
  const unresolved = await unresolvedBinary(input, snapshot.command);
  if (unresolved !== null) problems.push(unresolved);
  return problems;
}

/**
 * Techo de largo para el nombre de una entrada ajena en el informe.
 *
 * Generoso para identificar cualquier nombre real —el más largo de la captura no
 * llega a treinta— y acotado para que una clave de mil caracteres no empuje el
 * resto del renglón fuera de la pantalla.
 */
const ENTRY_NAME_MAX = 80;

/**
 * Techo para una ruta, un comando o la prosa del host.
 *
 * Más alto que el del nombre a propósito: una ruta absoluta real pasa los ochenta
 * caracteres sin esfuerzo y recortarla convierte la evidencia en algo que la
 * persona no puede ir a mirar. Sigue habiendo techo porque el dato es ajeno.
 */
const FREE_TEXT_MAX = 200;

/**
 * Un dato AJENO que va a parar a un renglón del informe, saneado para mostrarse.
 *
 * Una clave JSON —y un `command`, y el nombre que el propio host imprime—
 * admiten saltos de línea, retornos y controles, y la proyección humana une el
 * informe con `\n`: una entrada llamada
 * `"inocente\n  ✔ host/mcps/x — la conexion esta sana"` imprimía un renglón de
 * hallazgo que ningún hallazgo produjo, tapando visualmente uno real o
 * inventando un veredicto. Sanear sólo el nombre y dejar crudo el resto deja
 * abierta la misma puerta con otra llave, así que pasa por acá todo texto que
 * este proveedor no escribió.
 *
 * Saneado NO es anónimo: el archivo va siempre en `locator` y en la evidencia,
 * así que el recurso sigue siendo ubicable incluso cuando el texto se recortó.
 */
function displayText(raw: string, max = FREE_TEXT_MAX): string {
  const flat = raw
    // biome-ignore lint/suspicious/noControlCharactersInRegex: es exactamente lo que hay que sacar
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** El nombre de una entrada, saneado y con un texto de reemplazo si no quedó nada legible. */
function displayEntryName(name: string): string {
  const shown = displayText(name, ENTRY_NAME_MAX);
  return shown.length === 0 ? "(entrada con un nombre ilegible)" : shown;
}

/**
 * El id lleva el nombre CRUDO, y eso es deliberado.
 *
 * Sanearlo para el id parecía más prudente y era peor: los hallazgos viven en un
 * `Map` indexado por id, y dos nombres distintos que se reducen al mismo token
 * (`"a b"` y `"a/b"`, o dos nombres largos que comparten su prefijo) colapsan en
 * UNA fila y la otra desaparece en silencio — un doctor que se come un hallazgo
 * es peor que uno que lo muestra con un nombre raro. Dentro de un host y un
 * scope los nombres son claves de un objeto JSON, así que son únicos por
 * construcción y el id lo es también.
 *
 * Lo que el nombre ajeno podía romper era la PROYECCIÓN —una clave con saltos de
 * línea forja renglones de hallazgo falsos—, y eso se ataja donde se imprime:
 * `renderHuman` sanea cada línea que emite. Identidad y presentación son dos
 * problemas, y mezclarlos costaba la identidad.
 */

function foreignEntryFinding(
  host: string,
  scope: Scope,
  rawName: string,
  snapshot: ReturnType<typeof readMcpEntry>,
  problems: readonly string[],
): DoctorFinding {
  const healthy = problems.length === 0;
  const name = displayEntryName(rawName);
  return {
    id: doctorFindingId(host, CATEGORY, `${scope}:${rawName}`),
    host,
    category: CATEGORY,
    resource: { kind: "mcp-entry", name: `${name} (${scope})`, locator: snapshot.target },
    state: healthy ? "healthy" : "warning",
    summary: healthy
      ? `${name} es una entrada ajena y está bien formada`
      : `${name} es una entrada ajena con problemas: ${problems.join("; ")}`,
    impact: healthy
      ? "no es de Workline y no necesita nada"
      : "el host puede fallar al levantarla, y Workline no puede corregirla porque no es suya",
    evidence: [
      `archivo: ${snapshot.target}`,
      ...(name === rawName ? [] : ["el nombre se normalizó para el informe; el archivo manda"]),
      ...(snapshot.remote === true
        ? ["entrada remota: el host la alcanza por URL, sin binario que levantar"]
        : []),
      ...problems,
    ],
    ownership: "foreign",
    remediation: healthy
      ? { kind: "none", action: null, guidance: [] }
      : {
          kind: "manual",
          action: null,
          guidance: [`revisá ${snapshot.target} con quien haya configurado '${name}'`],
        },
  };
}

/**
 * The elicitation descriptor Workline writes into each host, judged by the same
 * predicate every other Workline descriptor is judged by.
 *
 * `classifyMcpEntry` compares the WHOLE generated shape, which is what stops a
 * release upgrade from calling the previous generation's descriptor foreign.
 */
function worklineEntryFinding(
  host: string,
  mcpHost: McpHost,
  scope: Scope,
  snapshot: ReturnType<typeof readMcpEntry>,
): DoctorFinding {
  const expected = worklineMcpEntry(mcpHost);
  const state = classifyMcpEntry(mcpHost, snapshot, expected, {
    name: WORKLINE_MCP_ENTRY_NAME,
    dsnVar: "",
  }).state;
  const ours = state === "current" || state === "known-legacy";
  const base = {
    id: doctorFindingId(host, CATEGORY, `${scope}:${WORKLINE_MCP_ENTRY_NAME}`),
    host,
    category: CATEGORY,
    resource: {
      kind: "mcp-entry" as const,
      name: `${WORKLINE_MCP_ENTRY_NAME} (${scope})`,
      locator: snapshot.target,
    },
    evidence: [`archivo: ${snapshot.target}`, `estado de la entrada: ${state}`],
  };
  if (state === "current") {
    return {
      ...base,
      state: "healthy",
      summary: `el descriptor de Workline está vigente en ${host}`,
      impact: "el host puede pedirle una elección estructurada a la persona por MCP",
      ownership: "ours",
      remediation: { kind: "none", action: null, guidance: [] },
    };
  }
  if (ours) {
    // Para ESTE descriptor, `known-legacy` sólo puede significar una cosa: está
    // en una ubicación que el host todavía lee y hay que moverlo. La otra mitad
    // de `known-legacy` —una GENERACIÓN anterior— exige un
    // `--descriptor-generation` en los argumentos, que el descriptor de
    // elicitación no tiene; esa mitad vive en las conexiones de base de datos, y
    // su reparación es reescribir en el lugar (`mcp.setup`), no mover.
    return {
      ...base,
      state: "warning",
      summary: `el descriptor de Workline en ${host} quedó en una ubicación que ya no es la vigente`,
      impact: "el host puede cargar el descriptor viejo junto al vigente",
      ownership: "ours",
      remediation: {
        kind: "manual",
        action: null,
        guidance: [`aw mcp migrate --host ${mcpHost} --scope ${scope}`],
      },
      proposal: {
        op: "mcp.migrate",
        args: { host: mcpHost, instance: WORKLINE_MCP_ENTRY_NAME, scope },
      },
    };
  }

  return {
    ...base,
    state: "warning",
    summary: `hay una entrada '${WORKLINE_MCP_ENTRY_NAME}' en ${host} que Workline no escribió`,
    impact: "Workline la preserva: reemplazarla borraría configuración de otra persona",
    ownership: "foreign",
    remediation: {
      kind: "manual",
      action: null,
      guidance: [`revisá ${snapshot.target} antes de tocar esa entrada`],
    },
  };
}

/**
 * A stdio command that resolves nowhere. Absolute paths are checked as paths, not through PATH.
 *
 * Las dos ramas van por un puerto: `ctx.process.which` y `ctx.fs.exists`. La
 * rama de ruta absoluta consultaba `existsSync` del disco real, y eso hacía que
 * el mismo archivo de configuración diera `healthy` en la máquina de quien
 * instaló el binario y `warning` en CI — el resultado del doctor dejaba de ser
 * función de lo que el contexto le entrega.
 */
async function unresolvedBinary(
  input: DoctorProviderInput,
  command: string | undefined,
): Promise<string | null> {
  if (command === undefined || command.length === 0) return null;
  // El comando lo escribió otra persona igual que el nombre, así que se nombra
  // saneado: se resuelve la ruta CRUDA y se muestra la versión de una sola línea.
  const shown = displayText(command);
  if (command.includes("/") || command.includes("\\")) {
    return (await input.ctx.fs.exists(command))
      ? null
      : `el binario '${shown}' no existe en esa ruta`;
  }
  const resolved = await input.ctx.process.which(command);
  return resolved === undefined ? `el binario '${shown}' no está en el PATH` : null;
}

interface NativeMerge {
  findings: DoctorFinding[];
  /** Por host: por qué no hay veredicto nativo, y de cuál de las dos clases es. */
  failures: Map<string, { failure: NativeReadFailure; reason: string }>;
}

/**
 * The host's own verdict, merged onto the entries already found.
 *
 * The asymmetry is deliberate and it is the spec's: OUR MCP that the host cannot
 * connect is `blocking`, because Workline promised that capability and it is not
 * there. Somebody else's failing MCP is a `warning` with written guidance and no
 * action, because the failure is real but the resource is not ours to repair.
 */
function nativeFindings(
  hosts: readonly DoctorProviderInput["hosts"][number][],
  owners: ReadonlyMap<string, DoctorFinding>,
  deps: NativeHostDeps,
): NativeMerge {
  const findings: DoctorFinding[] = [];
  const failures = new Map<string, { failure: NativeReadFailure; reason: string }>();
  for (const host of hosts) {
    // The native binary is named after the host's MCP id, not its catalog id:
    // Claude Code is `claude-code` in the catalog and `claude` on the PATH, and
    // comparing the wrong one silently skips the host it was meant to inspect.
    const binary = host.mcp_host;
    if (binary === null || !isNativeHost(binary)) continue;
    const read = readNativeMcpState(binary, deps);
    if (!read.ok) {
      failures.set(host.host, { failure: read.failure, reason: read.reason });
      continue;
    }
    for (const server of read.servers) {
      findings.push(nativeFinding(host.host, server, owners.get(ownerKey(host.host, server.name))));
    }
  }
  return { findings, failures };
}

function nativeFinding(
  host: string,
  server: NativeMcpServerState,
  owned: DoctorFinding | undefined,
): DoctorFinding {
  const ours = owned?.ownership === "ours";
  // Todo lo que sigue lo imprimió el host, no este proveedor: el nombre de un
  // servidor del JSON de codex admite saltos de línea igual que una clave de
  // configuración, y el detalle es texto libre del host. Se muestra saneado; el
  // cruce con el dueño ya se hizo contra el nombre CRUDO, que es el que el
  // archivo escribió.
  const name = displayEntryName(server.name);
  const evidence = [
    `${server.host} reporta '${name}' como ${server.health}`,
    ...(server.detail === null ? [] : [displayText(server.detail)]),
    ...(server.auth_status === null ? [] : [`auth_status: ${displayText(server.auth_status)}`]),
    ...(server.transport === null ? [] : [`transporte: ${displayText(server.transport)}`]),
  ];
  const base = {
    id: doctorFindingId(host, CATEGORY, `native:${server.name}`),
    host,
    category: CATEGORY,
    resource: { kind: "mcp-server", name, locator: null },
    evidence,
    ownership: (ours ? "ours" : "foreign") as DoctorFinding["ownership"],
  };
  if (server.health === "connected") {
    return {
      ...base,
      state: "healthy",
      summary: `${host} conecta '${name}'`,
      impact: "el servidor está disponible para el host",
      remediation: { kind: "none", action: null, guidance: [] },
    };
  }
  if (server.health === "disabled") {
    return {
      ...base,
      state: "healthy",
      summary: `'${name}' está deshabilitado a propósito en ${host}`,
      impact: "no está disponible, y eso es lo que alguien decidió",
      remediation: { kind: "none", action: null, guidance: [] },
    };
  }
  if (server.health === "unverified") {
    return {
      ...base,
      state: "unverified",
      summary: `${host} reportó '${name}' en un formato que este lector no reconoce`,
      impact: "no se puede afirmar que el servidor esté sano ni que esté roto",
      remediation: {
        kind: "manual",
        action: null,
        guidance: [`corré '${host} mcp list' y leé el estado de '${name}' a mano`],
      },
    };
  }
  const needsAuth = server.health === "needs-auth";
  return {
    ...base,
    state: ours ? "blocking" : "warning",
    summary: needsAuth
      ? `'${name}' necesita autenticación en ${host}`
      : `${host} no logra conectar '${name}'`,
    impact: ours
      ? "una capacidad que Workline configuró no está disponible en este host"
      : "el host arrastra un servidor que no levanta; Workline no lo tocó y no lo va a tocar",
    remediation: {
      kind: "manual",
      action: null,
      guidance: ours
        ? [`revisá la conexión con 'aw mcp doctor' y volvé a registrarla si hace falta`]
        : [`autenticá o corregí '${name}' con la herramienta que lo instaló`],
    },
  };
}

function coverageFor(
  host: DoctorProviderInput["hosts"][number],
  skipNative: boolean,
  failures: ReadonlyMap<string, { failure: NativeReadFailure; reason: string }>,
  unreadable: readonly string[],
): ReturnType<typeof coverage> {
  if (host.mcp_host === null) {
    return coverage(CATEGORY, host.host, "not-applicable", "el host no toma MCP por archivo");
  }
  // Fail-closed, y antes que cualquier otra cosa: si un archivo que el host
  // carga no se pudo decodificar, no se miró lo que declara. Decir «comprobada»
  // sobre bytes que nadie leyó es exactamente la cobertura que este modelo
  // existe para prohibir — y el veredicto salía 0 sin ninguna evidencia mientras
  // el host, con ese archivo roto, no levanta NINGÚN MCP.
  if (unreadable.length > 0) {
    return coverage(
      CATEGORY,
      host.host,
      "unavailable",
      `no se pudo decodificar ${unreadable.join(", ")}: no se miró ninguna entrada de ese archivo`,
    );
  }
  if (!isNativeHost(host.mcp_host)) {
    return coverage(CATEGORY, host.host, "checked");
  }
  if (skipNative) {
    return coverage(
      CATEGORY,
      host.host,
      "skipped",
      "--skip-native: no se consultó el estado nativo de los MCP del host",
    );
  }
  const failed = failures.get(host.host);
  if (failed === undefined) return coverage(CATEGORY, host.host, "checked");
  // Un host `residual-config` es, por definición, un directorio de configuración
  // que quedó sin runtime: que su binario no esté es su estado NORMAL, no un
  // proveedor caído. Contabilizarlo como `unavailable` hacía que un directorio
  // huérfano de un host desinstalado meses atrás volviera roja —exit 1, y con
  // ella el build de CI— una máquina impecable. Se distingue «no pude mirar
  // porque el host no está» de «no pude mirar y eso es un problema».
  if (failed.failure === "absent" && host.status === "residual-config") {
    return coverage(
      CATEGORY,
      host.host,
      "skipped",
      `${failed.reason}: el host quedó sin runtime, así que no hay estado nativo que consultar`,
    );
  }
  return coverage(CATEGORY, host.host, "unavailable", failed.reason);
}

function isNativeHost(host: string): host is NativeMcpHost {
  return (NATIVE_MCP_HOSTS as readonly string[]).includes(host);
}
