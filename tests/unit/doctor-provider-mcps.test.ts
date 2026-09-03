import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NativeHostRunResult } from "../../src/application/doctor/native-host-state.js";
import { createMcpsProvider } from "../../src/application/doctor/provider-mcps.js";
import type {
  DoctorProviderInput,
  DoctorProviderOutput,
  DoctorTargetHost,
} from "../../src/application/doctor/types.js";
import { PathsService } from "../../src/application/paths-service.js";
import type { CliContext } from "../../src/cli/types.js";
import {
  type DoctorCoverage,
  type DoctorFinding,
  doctorFindingId,
  doctorVerdict,
} from "../../src/domain/doctor/model.js";
import { HARNESSES, type HarnessId, harnessById } from "../../src/domain/harnesses.js";
import { redactSensitiveValue } from "../../src/domain/redaction.js";
import { WORKLINE_MCP_ENTRY_NAME } from "../../src/domain/workline-mcp-entry.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { FakeProcess } from "../helpers/fake-process.js";
import { NodeFileSystem } from "../helpers/real-fs.js";

/**
 * La promesa asimétrica del proveedor de MCPs: se DIAGNOSTICA todo, se ACCIONA
 * sólo lo propio.
 *
 * El `mcp doctor` que ya existía era ciego a la otra mitad del archivo: sólo
 * miraba las conexiones registradas por Workline, así que un servidor ajeno con
 * el binario borrado o con una credencial pegada en `env` le costaba el host a
 * la persona sin aparecer en ningún informe. La corrección tiene un filo
 * peligroso —diagnosticar lo ajeno invita a repararlo— y por eso lo que se fija
 * acá no es un hallazgo elegido a mano sino la regla sobre TODOS los ajenos de
 * la corrida: jamás una acción, jamás una remediación automatizable.
 *
 * El estado nativo va con el runner inyectado a propósito: sin eso el proveedor
 * spawnea `claude mcp list` y `codex mcp list --json` de la máquina que corre la
 * suite, que conecta cada servidor de verdad y hace depender el resultado del
 * entorno del desarrollador.
 *
 * Las tres fuentes de hallazgos —el registro de conexiones, el archivo del host
 * y el veredicto nativo— se ejercitan las tres: una corrida sin conexiones
 * registradas deja MUERTO al primer productor entero, y con él la única mitad
 * que puede decir 'ours' sobre algo que no sea el descriptor de elicitation.
 */

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../fixtures/doctor/${name}`, import.meta.url)), "utf8");

/** Capturas reales de los dos hosts nativos: la única fuente de la salud esperada. */
const CLAUDE_MCP_LIST = fixture("claude-mcp-list.txt");
const CODEX_MCP_LIST = fixture("codex-mcp-list.json");

/** Un servidor de la captura que el host declara NO conectado, y no es de Workline. */
const FOREIGN_UNCONNECTED = "plugin:figma:figma";

const FOREIGN_HEALTHY = "context7";
const FOREIGN_BROKEN_BINARY = "ghost-mcp";
const FOREIGN_WITH_CREDENTIAL = "billing-api";
/** Valor con forma de secreto: ni el resumen ni la evidencia pueden reflejarlo. */
const EMBEDDED_SECRET = "sk-live-9f3ac41b7d2e4d0f";

const CLAUDE_HOST: HarnessId = "claude-code";
const CODEX_HOST: HarnessId = "codex";
/**
 * Las dos conexiones que la captura de `claude mcp list` muestra lanzadas por el
 * propio CLI de Workline (`... agent-workflow-cli ... mcp serve-db`).
 *
 * Registrarlas es lo que hace honesta a la corrida: sin registro, la captura
 * real deja a dos servidores PROPIOS contados como ajenos, y la partición
 * 'ajenos' se infla con casos que en la máquina de origen no lo son.
 */
const OWN_CONNECTIONS = [
  { name: "qtc-cert", dsnVar: "DB_QTC_CERT_DSN" },
  { name: "qtc-prod", dsnVar: "DB_QTC_PROD_DSN" },
] as const;

/**
 * El descriptor de elicitation CONGELADO, no derivado del generador.
 *
 * Si el esperado se calculara con `worklineMcpEntry()` —la misma expresión que
 * usa producción para clasificar— la prueba seguiría verde ante cualquier
 * cambio de forma, porque generación y clasificación se moverían juntas. Las dos
 * variantes se congelan por separado y el test elige por plataforma: la elección
 * es del fixture, no del código bajo prueba.
 */
const WORKLINE_DESCRIPTOR_POSIX = {
  command: "agent-workflow",
  args: ["mcp", "serve", "--host", "claude"],
  env: {},
};
const WORKLINE_DESCRIPTOR_WIN32 = {
  command: "cmd",
  args: ["/c", "agent-workflow", "mcp", "serve", "--host", "claude"],
  env: {},
};
const WORKLINE_DESCRIPTOR: Record<string, unknown> =
  process.platform === "win32" ? WORKLINE_DESCRIPTOR_WIN32 : WORKLINE_DESCRIPTOR_POSIX;

/** El descriptor de una conexión de base en scope workspace, también congelado. */
function dbDescriptor(instance: string): Record<string, unknown> {
  const serve = [
    "mcp",
    "serve-db",
    "--namespace",
    "workflow",
    "--instance",
    instance,
    "--host",
    "claude",
    "--scope",
    "workspace",
  ];
  return process.platform === "win32"
    ? { command: "cmd", args: ["/c", "agent-workflow", ...serve], env: {} }
    : { command: "agent-workflow", args: serve, env: {} };
}

/**
 * El sufijo de estado tal como el host lo imprimió para ese servidor.
 *
 * Se extrae de la captura en vez de escribirse a mano para que la línea propia
 * que fabrica el test más abajo declare EXACTAMENTE la misma salud que la
 * ajena: si las dos salidas difieren, la asimetría que se quiere demostrar
 * podría venir de la salud y no de la propiedad.
 */
function capturedStatusOf(server: string): string {
  const line = CLAUDE_MCP_LIST.split("\n").find((candidate) => candidate.startsWith(`${server}:`));
  if (line === undefined) throw new Error(`la captura no trae la línea de '${server}'`);
  const cut = line.lastIndexOf(" - ");
  if (cut === -1) throw new Error(`la línea de '${server}' no trae estado`);
  return line.slice(cut + 3).trim();
}

/** La captura real, más el descriptor propio reportado con la MISMA salud ajena. */
function claudeListWithUnconnectedWorkline(): string {
  const status = capturedStatusOf(FOREIGN_UNCONNECTED);
  return `${CLAUDE_MCP_LIST}\n${WORKLINE_MCP_ENTRY_NAME}: agent-workflow mcp serve --host claude - ${status}\n`;
}

/** La captura real más líneas sintéticas, para las marcas que la captura no trae. */
function claudeListPlus(...lines: string[]): string {
  return `${CLAUDE_MCP_LIST}\n${lines.join("\n")}\n`;
}

/** La captura real de codex más servidores sintéticos, para formas que no trae. */
function codexListPlus(...servers: Record<string, unknown>[]): string {
  const captured = JSON.parse(CODEX_MCP_LIST) as unknown[];
  return JSON.stringify([...captured, ...servers]);
}

/**
 * La respuesta del host nativo: su salida, un error de spawn, o un código de
 * salida. Las tres porque «no hay binario» y «el binario contestó mal» son dos
 * fallas distintas y la cobertura las trata distinto.
 */
type CannedNative = string | { errorCode: string } | { status: number };

/** Runner nativo inyectado: responde por host y registra si lo consultaron. */
function nativeRunner(canned: Record<string, CannedNative>): {
  run: (command: string, args: readonly string[], timeoutMs: number) => NativeHostRunResult;
  calls: { command: string; args: string[] }[];
} {
  const calls: { command: string; args: string[] }[] = [];
  return {
    calls,
    run: (command, args) => {
      calls.push({ command, args: [...args] });
      const answer = canned[command];
      if (answer === undefined) {
        throw new Error(`el proveedor consultó un host nativo no previsto: ${command}`);
      }
      if (typeof answer !== "string") {
        return "errorCode" in answer
          ? { status: null, stdout: "", errorCode: answer.errorCode, timedOut: false }
          : { status: answer.status, stdout: "", errorCode: null, timedOut: false };
      }
      return { status: 0, stdout: answer, errorCode: null, timedOut: false };
    },
  };
}

/**
 * El puerto de archivos del contexto, con respuestas que pueden CONTRADECIR al
 * disco real.
 *
 * Es lo único que vuelve observable POR QUÉ vía pregunta el proveedor: la rama
 * de ruta absoluta de `unresolvedBinary` consultaba `existsSync` de `node:fs`,
 * así que el mismo archivo de configuración daba `healthy` en la máquina de
 * quien instaló el binario y `warning` en CI, y ningún doble podía intervenir.
 */
class ContextFs extends NodeFileSystem {
  constructor(private readonly answers: Map<string, boolean>) {
    super();
  }
  override async exists(path: string): Promise<boolean> {
    return this.answers.get(path) ?? super.exists(path);
  }
}

let root: string;
let workspace: string;
let home: string;
let ghostBinary: string;
let fsAnswers: Map<string, boolean>;
let ctx: CliContext;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "doctor-mcps-"));
  workspace = join(root, "ws");
  home = join(root, "home");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(home, { recursive: true });
  // Ruta absoluta que nunca se crea: el proveedor la resuelve como ruta, no por PATH.
  ghostBinary = join(root, "no-instalado", "ghost-mcp");
  fsAnswers = new Map<string, boolean>();
  ctx = {
    env: new FakeEnv(home, workspace),
    paths: new PathsService(normalizeNamespace("workflow"), home, workspace),
    process: new FakeProcess({ which: (cmd) => (cmd === "npx" ? "/usr/bin/npx" : undefined) }),
    fs: new ContextFs(fsAnswers),
  } as unknown as CliContext;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** El host tal como lo declara el catálogo: `mcp_host` no se inventa en el test. */
function targetHost(id: HarnessId): DoctorTargetHost {
  const spec = harnessById(id);
  if (spec === null) throw new Error(`el catálogo no declara el host '${id}'`);
  return {
    host: spec.id,
    target: spec.installTarget,
    label: spec.label,
    status: "ready",
    current: false,
    runtime: { state: "present", version: null },
    workline_installed: true,
    mcp_host: spec.mcpHostId,
  };
}

function inputFor(
  hosts: DoctorTargetHost[],
  options: { skipNative?: boolean } = {},
): DoctorProviderInput {
  return {
    ctx,
    hosts,
    hostStates: [],
    currentHost: null,
    workspaceDir: workspace,
    skipNative: options.skipNative ?? false,
  };
}

function writeJson(target: string, value: unknown): void {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(value, null, 2));
}

function writeClaudeWorkspaceConfig(servers: Record<string, unknown>): void {
  writeJson(join(workspace, ".mcp.json"), { mcpServers: servers });
}

/** El archivo de scope GLOBAL de claude, dentro del home temporal. */
function writeClaudeGlobalConfig(servers: Record<string, unknown>): void {
  writeJson(join(home, ".claude.json"), { mcpServers: servers });
}

/** La ubicación histórica que claude sigue cargando. */
function writeClaudeLegacyConfig(servers: Record<string, unknown>): void {
  writeJson(join(workspace, ".claude", "settings.json"), { mcpServers: servers });
}

/**
 * Conexiones en el registro de Workline, con su DSN visible salvo pedido.
 *
 * Es lo único que despierta al productor de hallazgos de conexión propia: sin
 * registro, `readMcpConnections` devuelve [] y `driftReports` corta antes de
 * consultar nada.
 */
function registerConnections(
  connections: readonly { name: string; dsnVar: string }[],
  options: { dsn?: boolean } = {},
): void {
  const dev = join(home, ".workflow", "dev");
  mkdirSync(dev, { recursive: true });
  writeFileSync(
    join(dev, "mcp-connections.json"),
    `${JSON.stringify(
      {
        version: 2,
        connections: connections.map((connection) => ({ ...connection, provider: "postgres" })),
      },
      null,
      2,
    )}\n`,
  );
  if (options.dsn === false) return;
  writeFileSync(
    join(dev, "dsn.env"),
    `${connections
      .map(
        (connection) => `${connection.dsnVar}=postgres://usuario@localhost:5432/${connection.name}`,
      )
      .join("\n")}\n`,
  );
}

function entryId(host: HarnessId, scope: "workspace" | "global", name: string): string {
  return doctorFindingId(host, "mcps", `${scope}:${name}`);
}

/**
 * Los hallazgos del registro de conexiones se identifican por el id de CATÁLOGO,
 * igual que todos los demás.
 *
 * Antes salían con el id del motor de MCP (`claude` en vez de `claude-code`) y
 * eso partía un host en dos filas del informe; peor, `nativeFindings` busca al
 * dueño por id de catálogo, así que una conexión propia que el host no lograba
 * conectar nunca se reconocía como propia y volvía como advertencia ajena en vez
 * del bloqueo que la spec promete. Esta prueba fija el id corregido.
 */
function connectionId(scope: "workspace" | "global", name: string): string {
  return doctorFindingId(CLAUDE_HOST, "mcps", `${scope}:${name}`);
}

function nativeId(host: HarnessId, server: string): string {
  return doctorFindingId(host, "mcps", `native:${server}`);
}

function findingAt(output: DoctorProviderOutput, id: string): DoctorFinding {
  const finding = output.findings.find((candidate) => candidate.id === id);
  if (finding === undefined) {
    throw new Error(
      `no hay hallazgo '${id}'; la corrida trajo: ${output.findings.map((f) => f.id).join(", ")}`,
    );
  }
  return finding;
}

/** Todos los hallazgos que hablan del MISMO recurso, sin importar quién los produjo. */
function findingsAbout(output: DoctorProviderOutput, resourceName: string): DoctorFinding[] {
  return output.findings.filter((finding) => finding.resource.name === resourceName);
}

function coverageAt(output: DoctorProviderOutput, host: string): DoctorCoverage {
  const entry = output.coverage.find((candidate) => candidate.host === host);
  if (entry === undefined) throw new Error(`la corrida no declaró cobertura para '${host}'`);
  return entry;
}

describe("proveedor de MCPs — entradas ajenas en la configuración del host", () => {
  beforeEach(() => {
    // La corrida imita a la máquina de la captura: qtc-cert y qtc-prod están
    // registradas —son de Workline— y el resto del archivo es de otra gente.
    registerConnections(OWN_CONNECTIONS);
    writeClaudeWorkspaceConfig({
      [WORKLINE_MCP_ENTRY_NAME]: WORKLINE_DESCRIPTOR,
      [FOREIGN_HEALTHY]: { command: "npx", args: ["-y", "@upstash/context7-mcp"], env: {} },
      [FOREIGN_BROKEN_BINARY]: { command: ghostBinary, args: ["serve"], env: {} },
      [FOREIGN_WITH_CREDENTIAL]: {
        command: "npx",
        args: ["-y", "billing-mcp"],
        env: { API_KEY: EMBEDDED_SECRET },
      },
    });
  });

  async function runOverEntries(): Promise<DoctorProviderOutput> {
    const native = nativeRunner({ claude: claudeListWithUnconnectedWorkline() });
    return createMcpsProvider({ native: { run: native.run } }).run(
      inputFor([targetHost(CLAUDE_HOST)]),
    );
  }

  it("ningún hallazgo ajeno de la corrida propone una acción ni una remediación automatizable", async () => {
    const output = await runOverEntries();

    // Sobre TODOS los ajenos —los del archivo y los que reporta el host—, no
    // sobre uno elegido: la regla es del proveedor, no de una rama suya.
    const foreign = output.findings.filter((finding) => finding.ownership === "foreign");
    expect(foreign.length).toBeGreaterThan(0);
    for (const finding of foreign) {
      expect(
        finding.remediation.action,
        `${finding.id} propone accionar sobre algo ajeno`,
      ).toBeNull();
      expect(
        ["manual", "none"],
        `${finding.id} ofrece una remediación automatizable sobre algo ajeno`,
      ).toContain(finding.remediation.kind);
    }

    // Y la partición no es vacua: lo propio SÍ se reconoce como propio, que es
    // la mitad sobre la que la asimetría del estado nativo se apoya. Los tres
    // productores aportan: el registro de conexiones, el archivo y lo nativo.
    const ours = output.findings
      .filter((finding) => finding.ownership === "ours")
      .map((finding) => finding.id);
    expect(ours).toContain(entryId(CLAUDE_HOST, "workspace", WORKLINE_MCP_ENTRY_NAME));
    expect(ours).toContain(nativeId(CLAUDE_HOST, WORKLINE_MCP_ENTRY_NAME));
    for (const connection of OWN_CONNECTIONS) {
      expect(ours).toContain(connectionId("workspace", connection.name));
      expect(ours).toContain(connectionId("global", connection.name));
    }

    // Lo que el registro conoce nunca cae del lado ajeno por el camino del
    // archivo: es lo que evita adjudicarle a otra persona una conexión propia.
    const foreignIds = foreign.map((finding) => finding.id);
    for (const connection of OWN_CONNECTIONS) {
      expect(foreignIds).not.toContain(connectionId("workspace", connection.name));
      expect(foreignIds).not.toContain(entryId(CLAUDE_HOST, "workspace", connection.name));
    }
  });

  it("una entrada ajena cuyo binario stdio no resuelve sale warning y la evidencia dice cuál falta", async () => {
    const finding = findingAt(
      await runOverEntries(),
      entryId(CLAUDE_HOST, "workspace", FOREIGN_BROKEN_BINARY),
    );

    expect(finding.state).toBe("warning");
    expect(finding.ownership).toBe("foreign");
    expect(finding.evidence.join(" | ")).toContain(ghostBinary);
    expect(finding.evidence.join(" | ")).toContain("no existe");
  });

  it("una entrada ajena con credencial embebida sale warning sin filtrar el valor del secreto", async () => {
    const output = await runOverEntries();
    const finding = findingAt(output, entryId(CLAUDE_HOST, "workspace", FOREIGN_WITH_CREDENTIAL));

    expect(finding.state).toBe("warning");
    expect(finding.evidence.join(" | ")).toContain("credencial");
    // El informe es la superficie donde un secreto pegado en el archivo se
    // filtraría a un log o a un pantallazo: ninguna parte de la corrida —resumen,
    // evidencia o cualquier otro campo— puede reflejarlo.
    expect(JSON.stringify(output)).not.toContain(EMBEDDED_SECRET);
  });

  it("una entrada ajena bien formada sale healthy y sin remediación", async () => {
    const finding = findingAt(
      await runOverEntries(),
      entryId(CLAUDE_HOST, "workspace", FOREIGN_HEALTHY),
    );

    expect(finding.state).toBe("healthy");
    expect(finding.ownership).toBe("foreign");
    expect(finding.remediation.kind).toBe("none");
    expect(finding.remediation.guidance).toEqual([]);
  });
});

describe("proveedor de MCPs — el descriptor de elicitation que Workline escribe", () => {
  it("el descriptor propio no queda declarado ajeno por estar fuera del registro de conexiones", async () => {
    // No es una conexión de base registrada, así que el registro no lo conoce:
    // llamarlo ajeno le diría a la persona que su propia instalación es de otro.
    // La forma escrita es la CONGELADA, no la que produce el generador.
    writeClaudeWorkspaceConfig({ [WORKLINE_MCP_ENTRY_NAME]: WORKLINE_DESCRIPTOR });
    const native = nativeRunner({ claude: "" });

    const output = await createMcpsProvider({ native: { run: native.run } }).run(
      inputFor([targetHost(CLAUDE_HOST)]),
    );
    const finding = findingAt(output, entryId(CLAUDE_HOST, "workspace", WORKLINE_MCP_ENTRY_NAME));

    expect(finding.ownership).toBe("ours");
    expect(finding.state).toBe("healthy");
  });

  it("un descriptor propio en la ubicación histórica sigue siendo PROPIO, no ajeno", async () => {
    // El defecto que costó la release del quick 157: cada instalación que mueve
    // o reversiona el descriptor volvía 'foreign' lo que Workline misma escribió,
    // y un hallazgo ajeno no propone jamás la reinstalación que lo arregla.
    writeClaudeLegacyConfig({ [WORKLINE_MCP_ENTRY_NAME]: WORKLINE_DESCRIPTOR });
    const native = nativeRunner({ claude: "" });

    const output = await createMcpsProvider({ native: { run: native.run } }).run(
      inputFor([targetHost(CLAUDE_HOST)]),
    );
    const finding = findingAt(output, entryId(CLAUDE_HOST, "workspace", WORKLINE_MCP_ENTRY_NAME));

    expect(finding.ownership).toBe("ours");
    expect(finding.state).toBe("warning");
    expect(finding.evidence.join(" | ")).toContain("known-legacy");
    expect(finding.remediation.kind).toBe("manual");
    expect(finding.remediation.guidance).toContain("aw self mcp install-claude");
  });

  it("una entrada llamada 'agent-workflow' que Workline no escribió queda ajena y se preserva", async () => {
    // Mismo nombre, otra forma: es de otra persona y reemplazarla le borraría
    // su configuración, así que no puede salir 'ours' ni proponer install.
    writeClaudeWorkspaceConfig({
      [WORKLINE_MCP_ENTRY_NAME]: { command: "npx", args: ["-y", "otro-servidor"], env: {} },
    });
    const native = nativeRunner({ claude: "" });

    const output = await createMcpsProvider({ native: { run: native.run } }).run(
      inputFor([targetHost(CLAUDE_HOST)]),
    );
    const finding = findingAt(output, entryId(CLAUDE_HOST, "workspace", WORKLINE_MCP_ENTRY_NAME));

    expect(finding.ownership).toBe("foreign");
    expect(finding.state).toBe("warning");
    expect(finding.remediation.action).toBeNull();
    expect(finding.remediation.guidance.join(" | ")).not.toContain("install-claude");
  });
});

describe("proveedor de MCPs — las conexiones que Workline sí registró", () => {
  const [CERT] = OWN_CONNECTIONS;

  async function runWithConnections(): Promise<DoctorProviderOutput> {
    const native = nativeRunner({ claude: "" });
    return createMcpsProvider({ native: { run: native.run } }).run(
      inputFor([targetHost(CLAUDE_HOST)]),
    );
  }

  it("una conexión registrada que coincide sale healthy y propia, y NO se reporta además como ajena", async () => {
    // Los dos productores miran el mismo nombre en el mismo archivo: sin la
    // guarda, el mismo recurso aparece dos veces y la copia ajena contradice a
    // la propia (o la pisa, según con qué id se la nombre).
    registerConnections([CERT]);
    writeClaudeWorkspaceConfig({ [CERT.name]: dbDescriptor(CERT.name) });

    const output = await runWithConnections();
    const finding = findingAt(output, connectionId("workspace", CERT.name));

    expect(finding.state).toBe("healthy");
    expect(finding.ownership).toBe("ours");
    expect(finding.evidence).toContain("drift: ok");
    expect(finding.remediation.kind).toBe("none");
    expect(findingsAbout(output, `${CERT.name} (workspace)`)).toHaveLength(1);
  });

  it("una conexión registrada sin su entrada en ese scope sale warning propio con la guía de setup", async () => {
    registerConnections([CERT]);
    writeClaudeWorkspaceConfig({ [CERT.name]: dbDescriptor(CERT.name) });

    // La entrada está en workspace y falta en global: el mismo recurso, el otro scope.
    const finding = findingAt(await runWithConnections(), connectionId("global", CERT.name));

    expect(finding.state).toBe("warning");
    expect(finding.ownership).toBe("ours");
    expect(finding.evidence).toContain("drift: missing-mcp");
    expect(finding.summary).toContain(`falta la entrada de ${CERT.name}`);
    expect(finding.remediation.kind).toBe("manual");
    expect(finding.remediation.guidance).toContain(
      `aw mcp setup --host claude --instance ${CERT.name}`,
    );
  });

  it("una conexión registrada sin su DSN visible nombra la variable y jamás su valor", async () => {
    registerConnections([CERT], { dsn: false });
    writeClaudeWorkspaceConfig({ [CERT.name]: dbDescriptor(CERT.name) });

    const finding = findingAt(await runWithConnections(), connectionId("workspace", CERT.name));

    expect(finding.state).toBe("warning");
    expect(finding.ownership).toBe("ours");
    expect(finding.evidence).toContain("drift: dsn-mismatch");
    expect(finding.summary).toContain("DSN");
    expect(finding.remediation.guidance.join(" | ")).toContain(CERT.dsnVar);
    // La variable se nombra; su valor no aparece en ninguna parte del informe.
    expect(JSON.stringify(finding)).not.toContain("postgres://");
  });

  it("una conexión registrada cuya entrada tiene otra forma es AJENA y no se propone reescribirla", async () => {
    // El nombre está registrado, pero lo que hay en el archivo no lo escribió
    // Workline: pisarlo borraría la configuración de otra persona.
    registerConnections([CERT]);
    writeClaudeWorkspaceConfig({
      [CERT.name]: { command: "npx", args: ["-y", "otro-servidor-de-base"], env: {} },
    });

    const finding = findingAt(await runWithConnections(), connectionId("workspace", CERT.name));

    expect(finding.ownership).toBe("foreign");
    expect(finding.state).toBe("warning");
    expect(finding.evidence).toContain("estado de la entrada: foreign");
    expect(finding.remediation.kind).toBe("manual");
    expect(finding.remediation.action).toBeNull();
    expect(finding.remediation.guidance.join(" | ")).not.toContain("aw mcp setup");
  });

  it("una entrada ajena de scope global se diagnostica igual, y su id la ubica en global", async () => {
    // El home temporal es un scope de verdad: sin leerlo, la mitad global del
    // entorno —donde vive la mayoría de los MCP de una persona— queda ciega.
    writeClaudeGlobalConfig({
      "vendor-mcp": { command: ghostBinary, args: ["serve"], env: {} },
    });
    const native = nativeRunner({ claude: "" });

    const output = await createMcpsProvider({ native: { run: native.run } }).run(
      inputFor([targetHost(CLAUDE_HOST)]),
    );
    const finding = findingAt(output, entryId(CLAUDE_HOST, "global", "vendor-mcp"));

    expect(finding.id).toContain("global:");
    expect(finding.ownership).toBe("foreign");
    expect(finding.state).toBe("warning");
    expect(finding.resource.locator).toBe(join(home, ".claude.json"));
  });
});

describe("proveedor de MCPs — el veredicto del propio host sobre sus servidores", () => {
  it("lo que el host no conecta bloquea si es nuestro y sólo advierte si es ajeno", async () => {
    writeClaudeWorkspaceConfig({ [WORKLINE_MCP_ENTRY_NAME]: WORKLINE_DESCRIPTOR });
    const native = nativeRunner({ claude: claudeListWithUnconnectedWorkline() });

    const output = await createMcpsProvider({ native: { run: native.run } }).run(
      inputFor([targetHost(CLAUDE_HOST)]),
    );

    const ourServer = findingAt(output, nativeId(CLAUDE_HOST, WORKLINE_MCP_ENTRY_NAME));
    const foreignServer = findingAt(output, nativeId(CLAUDE_HOST, FOREIGN_UNCONNECTED));

    // Misma salud reportada por el host para los dos: lo único que cambia entre
    // ellos es de quién es el recurso, y eso es lo que la spec promete.
    expect(ourServer.evidence.join(" | ")).toContain("needs-auth");
    expect(foreignServer.evidence.join(" | ")).toContain("needs-auth");

    expect(ourServer.ownership).toBe("ours");
    expect(ourServer.state).toBe("blocking");

    expect(foreignServer.ownership).toBe("foreign");
    expect(foreignServer.state).toBe("warning");
    expect(foreignServer.remediation.kind).toBe("manual");
    expect(foreignServer.remediation.action).toBeNull();
    expect(foreignServer.remediation.guidance.length).toBeGreaterThan(0);
  });

  it("tener una entrada en el archivo no hace propio a un servidor ajeno que el host no conecta", async () => {
    // El filo de la asimetría: lo que decide 'blocking' es la PROPIEDAD, no la
    // mera existencia de una entrada homónima. Si bastara con que el nombre
    // esté en el archivo, el MCP roto de otra persona saldría como una promesa
    // incumplida de Workline —con su guía de 'volvé a registrarla'— y el
    // veredicto de la corrida terminaría en exit_code 1 por algo que no es suyo.
    writeClaudeWorkspaceConfig({
      [WORKLINE_MCP_ENTRY_NAME]: WORKLINE_DESCRIPTOR,
      [FOREIGN_UNCONNECTED]: { command: "npx", args: ["-y", "figma-mcp"], env: {} },
    });
    const native = nativeRunner({ claude: claudeListWithUnconnectedWorkline() });

    const output = await createMcpsProvider({ native: { run: native.run } }).run(
      inputFor([targetHost(CLAUDE_HOST)]),
    );

    // La entrada homónima existe de verdad en el archivo y es ajena: sin esto la
    // prueba sería vacua, porque el hallazgo nativo no tendría a quién mirar.
    const entry = findingAt(output, entryId(CLAUDE_HOST, "workspace", FOREIGN_UNCONNECTED));
    expect(entry.ownership).toBe("foreign");

    const server = findingAt(output, nativeId(CLAUDE_HOST, FOREIGN_UNCONNECTED));
    expect(server.ownership).toBe("foreign");
    expect(server.state).toBe("warning");
    expect(server.remediation.guidance.join(" | ")).not.toContain("aw mcp doctor");

    // Y el propio, con la misma salud y en la misma corrida, sí bloquea.
    expect(findingAt(output, nativeId(CLAUDE_HOST, WORKLINE_MCP_ENTRY_NAME)).state).toBe(
      "blocking",
    );
  });

  it("una CONEXIÓN registrada que el host no logra conectar bloquea, igual que el descriptor", async () => {
    // El otro productor de "propio", y el que más cuesta: hasta que el proveedor
    // dejó de nombrar al host con el id del motor de drift (`claude`) en vez del
    // de catálogo (`claude-code`), `nativeFindings` buscaba al dueño por id de
    // catálogo y JAMÁS encontraba una conexión registrada. Resultado: un MCP de
    // base de datos que Workline configuró y el host no puede levantar volvía
    // como advertencia AJENA —con guía para hablar con quien lo instaló— en vez
    // del bloqueo que la spec promete. La asimetría se demostraba sólo por el
    // descriptor de elicitation, que es propio por un caso especial del nombre.
    const [registered] = OWN_CONNECTIONS;
    registerConnections([registered]);
    writeClaudeWorkspaceConfig({ [registered.name]: dbDescriptor(registered.name) });
    const status = capturedStatusOf(FOREIGN_UNCONNECTED);
    const native = nativeRunner({
      claude: claudeListPlus(
        `${registered.name}: node serve-db --instance ${registered.name} - ${status}`,
      ),
    });

    const output = await createMcpsProvider({ native: { run: native.run } }).run(
      inputFor([targetHost(CLAUDE_HOST)]),
    );

    // La conexión se reconoce como propia por el registro, no por el nombre.
    const owner = findingAt(output, connectionId("workspace", registered.name));
    expect(owner.ownership).toBe("ours");

    const server = findingAt(output, nativeId(CLAUDE_HOST, registered.name));
    expect(server.ownership).toBe("ours");
    expect(server.state).toBe("blocking");
    expect(server.remediation.guidance.join(" | ")).toContain("aw mcp doctor");

    // Y en la misma corrida, con la MISMA salud reportada, el ajeno sólo advierte.
    const foreign = findingAt(output, nativeId(CLAUDE_HOST, FOREIGN_UNCONNECTED));
    expect(foreign.evidence.join(" | ")).toContain("needs-auth");
    expect(foreign.state).toBe("warning");
  });

  it("traduce el JSON de codex sin convertir en falla lo que alguien apagó a propósito", async () => {
    const native = nativeRunner({ codex: CODEX_MCP_LIST });

    const output = await createMcpsProvider({ native: { run: native.run } }).run(
      inputFor([targetHost(CODEX_HOST)]),
    );

    // `"enabled": false` en la captura es una decisión, no un fallo.
    const disabled = findingAt(output, nativeId(CODEX_HOST, "computer-use"));
    expect(disabled.state).toBe("healthy");
    expect(disabled.remediation.kind).toBe("none");

    // `"auth_status": "not_logged_in"` sobre un servidor que Workline no escribió.
    const needsAuth = findingAt(output, nativeId(CODEX_HOST, "figma"));
    expect(needsAuth.state).toBe("warning");
    expect(needsAuth.ownership).toBe("foreign");
    expect(needsAuth.remediation.action).toBeNull();

    expect(findingAt(output, nativeId(CODEX_HOST, "qtc-cert")).state).toBe("healthy");
    expect(coverageAt(output, CODEX_HOST).state).toBe("checked");
  });

  it("un servidor cuyo estado no se pudo interpretar sale unverified, jamás sano", async () => {
    // «No pude concluir» presentado como aprobado es la falla que este modelo
    // entero existe para evitar: la marca desconocida de claude y el objeto de
    // codex sin `enabled` booleano son los dos caminos que llegan hasta acá.
    const native = nativeRunner({
      claude: claudeListPlus("marca-nueva: npx -y raro - ◍ Estado que nadie parseó"),
      codex: codexListPlus({
        name: "forma-nueva",
        transport: { type: "stdio", command: "npx", args: [] },
        auth_status: "unsupported",
      }),
    });

    const output = await createMcpsProvider({ native: { run: native.run } }).run(
      inputFor([targetHost(CLAUDE_HOST), targetHost(CODEX_HOST)]),
    );

    const claudeUnknown = findingAt(output, nativeId(CLAUDE_HOST, "marca-nueva"));
    expect(claudeUnknown.state).toBe("unverified");
    expect(claudeUnknown.remediation.kind).toBe("manual");
    expect(claudeUnknown.remediation.guidance.length).toBeGreaterThan(0);

    const codexUnknown = findingAt(output, nativeId(CODEX_HOST, "forma-nueva"));
    expect(codexUnknown.state).toBe("unverified");

    // Y la cobertura sigue diciendo 'checked': el lector SÍ leyó, lo que no pudo
    // fue concluir sobre ese servidor. Confundir las dos cosas borra la distinción.
    expect(coverageAt(output, CLAUDE_HOST).state).toBe("checked");
  });

  it("un servidor que el host declara caído se distingue del que sólo necesita autenticación", async () => {
    // La captura sólo trae connected/needs-auth/disabled: sin una línea con la
    // marca de fallo, la mitad 'no logra conectar' del resumen no existe en pruebas.
    const native = nativeRunner({
      claude: claudeListPlus("caido-mcp: npx -y caido - ✘ Failed to connect"),
    });

    const output = await createMcpsProvider({ native: { run: native.run } }).run(
      inputFor([targetHost(CLAUDE_HOST)]),
    );

    const broken = findingAt(output, nativeId(CLAUDE_HOST, "caido-mcp"));
    expect(broken.state).toBe("warning");
    expect(broken.ownership).toBe("foreign");
    expect(broken.summary).toContain("no logra conectar");
    expect(broken.summary).not.toContain("autenticación");

    const needsAuth = findingAt(output, nativeId(CLAUDE_HOST, FOREIGN_UNCONNECTED));
    expect(needsAuth.summary).toContain("autenticación");
  });

  it("con --skip-native la cobertura queda skipped con su razón y no se emite ningún hallazgo nativo", async () => {
    writeClaudeWorkspaceConfig({
      [FOREIGN_HEALTHY]: { command: "npx", args: ["-y", "@upstash/context7-mcp"], env: {} },
    });
    // Sin respuestas cargadas: cualquier consulta al host nativo revienta el runner.
    const native = nativeRunner({});

    const output = await createMcpsProvider({ native: { run: native.run } }).run(
      inputFor([targetHost(CLAUDE_HOST), targetHost(CODEX_HOST)], { skipNative: true }),
    );

    for (const host of [CLAUDE_HOST, CODEX_HOST]) {
      expect(coverageAt(output, host).state).toBe("skipped");
      expect(coverageAt(output, host).reason ?? "").not.toBe("");
    }
    expect(output.findings.filter((finding) => finding.id.includes("native:"))).toEqual([]);
    // El resto del informe sigue siendo el informe: saltear lo nativo no apaga la categoría.
    expect(findingAt(output, entryId(CLAUDE_HOST, "workspace", FOREIGN_HEALTHY)).state).toBe(
      "healthy",
    );
  });

  it("un host cuyo binario no está deja la cobertura unavailable con la razón y el informe en pie", async () => {
    writeClaudeWorkspaceConfig({
      [FOREIGN_BROKEN_BINARY]: { command: ghostBinary, args: [], env: {} },
    });
    const native = nativeRunner({ claude: "", codex: { errorCode: "ENOENT" } });

    const output = await createMcpsProvider({ native: { run: native.run } }).run(
      inputFor([targetHost(CLAUDE_HOST), targetHost(CODEX_HOST)]),
    );

    expect(coverageAt(output, CODEX_HOST).state).toBe("unavailable");
    expect(coverageAt(output, CODEX_HOST).reason ?? "").toContain("no está en el PATH");
    expect(coverageAt(output, CLAUDE_HOST).state).toBe("checked");
    // El lector caído no se lleva puesto lo que sí se pudo leer del archivo.
    expect(findingAt(output, entryId(CLAUDE_HOST, "workspace", FOREIGN_BROKEN_BINARY)).state).toBe(
      "warning",
    );
    // Y una cobertura que no se pudo comprobar no puede terminar en "entorno sano".
    expect(doctorVerdict(output.findings, output.coverage).exit_code).toBe(1);
  });

  it("un host que no toma MCP por archivo queda not-applicable, no ausente ni sano", async () => {
    const noMcpHost = HARNESSES.find((spec) => spec.mcpHostId === null);
    if (noMcpHost === undefined) {
      throw new Error("el catálogo dejó de declarar un host sin MCP por archivo");
    }
    const native = nativeRunner({ claude: "" });

    const output = await createMcpsProvider({ native: { run: native.run } }).run(
      inputFor([targetHost(CLAUDE_HOST), targetHost(noMcpHost.id)]),
    );

    expect(coverageAt(output, noMcpHost.id).state).toBe("not-applicable");
    expect(coverageAt(output, noMcpHost.id).reason ?? "").not.toBe("");
    expect(output.findings.every((finding) => finding.host !== noMcpHost.id)).toBe(true);
  });

  it("una corrida sobre SÓLO hosts sin MCP por archivo no consulta nada y no inventa hallazgos", async () => {
    const noMcpHost = HARNESSES.find((spec) => spec.mcpHostId === null);
    if (noMcpHost === undefined) {
      throw new Error("el catálogo dejó de declarar un host sin MCP por archivo");
    }
    // Hay archivo y hay conexiones registradas: si el proveedor las leyera igual,
    // atribuiría entradas del workspace a un host que no toma MCP por archivo.
    registerConnections(OWN_CONNECTIONS);
    writeClaudeWorkspaceConfig({
      [FOREIGN_HEALTHY]: { command: "npx", args: ["-y", "@upstash/context7-mcp"], env: {} },
    });
    const native = nativeRunner({});

    const output = await createMcpsProvider({ native: { run: native.run } }).run(
      inputFor([targetHost(noMcpHost.id)]),
    );

    expect(native.calls).toEqual([]);
    expect(output.findings).toEqual([]);
    expect(coverageAt(output, noMcpHost.id).state).toBe("not-applicable");
    expect(coverageAt(output, noMcpHost.id).reason ?? "").not.toBe("");
  });
});

describe("proveedor de MCPs — entradas remotas, que no tienen binario ni lo necesitan", () => {
  /**
   * El defecto más caro del lote: `malformed` lo fijaba el lector cuando faltaba
   * `command`, porque hasta ahora sólo se leían las entradas stdio PROPIAS de
   * Workline. Aplicado al barrido de TODAS las entradas del host, cada servidor
   * remoto legítimo —el caso normal: la captura real de `claude mcp list` de
   * este mismo lote trae tres MCP HTTP conectados— salía con la advertencia «la
   * entrada no tiene la forma de un servidor MCP decodificable» y un impacto
   * («el host puede fallar al levantarla») que describe un problema inexistente.
   */
  async function runOverRemote(servers: Record<string, unknown>): Promise<DoctorProviderOutput> {
    writeClaudeWorkspaceConfig(servers);
    const native = nativeRunner({ claude: "" });
    return createMcpsProvider({ native: { run: native.run } }).run(
      inputFor([targetHost(CLAUDE_HOST)]),
    );
  }

  it("una entrada http y una sse salen sanas, sin inventarles una forma indecodificable", async () => {
    const output = await runOverRemote({
      linear: { type: "http", url: "https://mcp.linear.app/mcp" },
      sentry: { type: "sse", url: "https://mcp.sentry.dev/sse" },
    });

    for (const name of ["linear", "sentry"]) {
      const finding = findingAt(output, entryId(CLAUDE_HOST, "workspace", name));
      expect(finding.state, `${name} salió ${finding.state}`).toBe("healthy");
      expect(finding.ownership).toBe("foreign");
      expect(finding.remediation.kind).toBe("none");
      expect(finding.evidence.join(" | ")).not.toContain("decodificable");
      // Y la evidencia dice POR QUÉ no hay binario que comprobar, en vez de callarlo.
      expect(finding.evidence.join(" | ")).toContain("remota");
    }
  });

  it("una entrada remota sin URL sigue siendo indecodificable: la corrección no es 'todo pasa'", async () => {
    // El filo del arreglo: si bastara con no tener `command` para declararla
    // sana, una entrada que no declara servidor alguno pasaría en silencio.
    const finding = findingAt(
      await runOverRemote({ "a-medias": { type: "http" } }),
      entryId(CLAUDE_HOST, "workspace", "a-medias"),
    );

    expect(finding.state).toBe("warning");
    expect(finding.evidence.join(" | ")).toContain("decodificable");
  });

  it("la URL de una entrada remota no viaja al informe: puede llevar un token en la query", async () => {
    const output = await runOverRemote({
      privado: { type: "http", url: `https://mcp.example.com/mcp?token=${EMBEDDED_SECRET}` },
    });

    expect(JSON.stringify(output)).not.toContain(EMBEDDED_SECRET);
  });
});

describe("proveedor de MCPs — el informe pasa por el redactor y no puede salir mintiendo", () => {
  const [CERT] = OWN_CONNECTIONS;

  /**
   * El redactor real, aplicado como lo aplica `buildDoctorReport`.
   *
   * `SECRET_ASSIGNMENT` trata `…DSN` seguido de `=`, `:` o UN ESPACIO como una
   * asignación y reemplaza la palabra siguiente por `***`. Sobre una negación
   * eso no oscurece: INVIERTE. «DB_QTC_CERT_DSN no está en …» salía como
   * «DB_QTC_CERT_DSN *** está en …», afirmando lo contrario de lo observado, y
   * la guía «export DB_QTC_CERT_DSN=***» copiada tal cual deja esa basura en el
   * `.zshenv` de la persona: `isDsnVisible` pasa a dar true para siempre y el
   * doctor declara SANA una conexión que no puede autenticarse.
   */
  function redacted(finding: DoctorFinding): DoctorFinding {
    return redactSensitiveValue(finding) as DoctorFinding;
  }

  it("la evidencia, el resumen y la guía de un DSN ausente sobreviven al redactor sin invertirse", async () => {
    registerConnections([CERT], { dsn: false });
    writeClaudeWorkspaceConfig({ [CERT.name]: dbDescriptor(CERT.name) });
    const native = nativeRunner({ claude: "" });

    const output = await createMcpsProvider({ native: { run: native.run } }).run(
      inputFor([targetHost(CLAUDE_HOST)]),
    );
    const finding = redacted(findingAt(output, connectionId("workspace", CERT.name)));

    // La negación sigue siendo una negación después de redactar.
    const evidence = finding.evidence.join(" | ");
    expect(evidence).toContain("no está en");
    expect(evidence).not.toContain("***");
    // Y la variable se sigue nombrando: es justo lo que el hallazgo le debe a la persona.
    expect(evidence).toContain(CERT.dsnVar);

    expect(finding.summary).toContain(CERT.dsnVar);
    expect(finding.summary).not.toContain("***");

    const guidance = finding.remediation.guidance.join(" | ");
    expect(guidance).toContain(CERT.dsnVar);
    expect(guidance).not.toContain("***");

    // Y el valor del DSN sigue sin aparecer por ninguna parte.
    expect(JSON.stringify(finding)).not.toContain("postgres://");
  });

  it("un drift sin entrada ni DSN tampoco se come la palabra suelta del motor", async () => {
    // El motor escribe «Ni DSN ni MCP registrados para …»: la misma trampa sobre
    // una mención que no es el nombre completo de la variable.
    registerConnections([CERT], { dsn: false });
    const native = nativeRunner({ claude: "" });

    const output = await createMcpsProvider({ native: { run: native.run } }).run(
      inputFor([targetHost(CLAUDE_HOST)]),
    );
    const finding = redacted(findingAt(output, connectionId("workspace", CERT.name)));

    expect(finding.evidence.join(" | ")).not.toContain("***");
  });
});

describe("proveedor de MCPs — el nombre de una entrada ajena no puede forjar el informe", () => {
  /**
   * Una clave JSON admite saltos de línea, y la proyección humana une el informe
   * con `\n`: una entrada llamada `"inocente\n  ✔ …"` imprimía un renglón de
   * hallazgo que NINGÚN hallazgo produjo —tapando uno real o inventando un
   * veredicto—, y el id dejaba de ser un token que se pueda escribir en una
   * línea de comandos.
   */
  const FORGED = `inocente\n  ✔ ${CLAUDE_HOST}/mcps/workspace:qtc-cert — la conexion esta sana\n      impacto: ninguno`;

  it("un nombre con saltos de línea se sanea para mostrarse, y el id conserva el nombre entero", async () => {
    writeClaudeWorkspaceConfig({ [FORGED]: { command: ghostBinary, args: [], env: {} } });
    const native = nativeRunner({ claude: "" });

    const output = await createMcpsProvider({ native: { run: native.run } }).run(
      inputFor([targetHost(CLAUDE_HOST)]),
    );

    const forged = output.findings.filter((finding) => finding.resource.kind === "mcp-entry");
    expect(forged).toHaveLength(1);
    const [finding] = forged;
    if (finding === undefined) throw new Error("la corrida no diagnosticó la entrada ajena");

    // Los campos que se MUESTRAN van aplanados: es donde el forjado dolía.
    expect(finding.resource.name).not.toMatch(/[\n\r]/);
    expect(finding.summary).not.toMatch(/[\n\r]/);
    expect(finding.impact).not.toMatch(/[\n\r]/);
    for (const evidence of finding.evidence) expect(evidence).not.toMatch(/[\n\r]/);
    // Y sigue siendo identificable: el archivo donde vive va en el hallazgo.
    expect(finding.resource.locator).toBe(join(workspace, ".mcp.json"));
    expect(finding.resource.name).toContain("inocente");

    // El id conserva el nombre CRUDO a propósito: los hallazgos se indexan por
    // id, así que un id saneado hace colapsar dos entradas distintas en una y la
    // otra desaparece del informe. Lo que no puede forjar renglones es la
    // PROYECCIÓN, y eso lo garantiza `renderHuman`, no el id.
    expect(finding.id).toContain(FORGED);
  });

  it("dos nombres distintos NUNCA colapsan en un solo hallazgo", async () => {
    // El precio de sanear el id: `"a b"` y `"a/b"` se reducían al mismo token, y
    // como los hallazgos viven en un Map indexado por id, uno de los dos
    // desaparecía en silencio. Un doctor que se come un hallazgo es peor que uno
    // que lo muestra con un nombre raro.
    writeClaudeWorkspaceConfig({
      "a b": { command: "npx", args: [], env: {} },
      "a/b": { command: ghostBinary, args: [], env: {} },
      [`z${"z".repeat(120)}-uno`]: { command: "npx", args: [], env: {} },
      [`z${"z".repeat(120)}-dos`]: { command: ghostBinary, args: [], env: {} },
    });
    const native = nativeRunner({ claude: "" });

    const output = await createMcpsProvider({ native: { run: native.run } }).run(
      inputFor([targetHost(CLAUDE_HOST)]),
    );

    const entries = output.findings.filter((finding) => finding.resource.kind === "mcp-entry");
    expect(entries).toHaveLength(4);
    expect(new Set(entries.map((finding) => finding.id)).size).toBe(4);
    // Y los dos que traen un binario inexistente siguen advirtiendo: ninguno se
    // perdió detrás del otro.
    expect(entries.filter((finding) => finding.state === "warning")).toHaveLength(2);
  });

  it("el comando de una entrada ajena tampoco puede forjar renglones", async () => {
    // La misma puerta con otra llave: sanear el nombre y dejar crudo el
    // `command` —que lo escribió la misma persona ajena y también viaja a la
    // evidencia— deja el forjado abierto igual.
    const comando = `/no/existe\n  ✔ ${CLAUDE_HOST}/mcps/workspace:qtc-prod — todo sano`;
    writeClaudeWorkspaceConfig({ "vendor-mcp": { command: comando, args: [], env: {} } });
    const native = nativeRunner({ claude: "" });

    const output = await createMcpsProvider({ native: { run: native.run } }).run(
      inputFor([targetHost(CLAUDE_HOST)]),
    );
    const finding = findingAt(output, entryId(CLAUDE_HOST, "workspace", "vendor-mcp"));

    expect(finding.state).toBe("warning");
    expect(JSON.stringify(finding)).not.toMatch(/\\n|\\r/);
    // Y la ruta sigue nombrada: saneada no es anónima.
    expect(finding.evidence.join(" | ")).toContain("/no/existe");
  });

  it("el nombre que el propio host imprime tampoco entra crudo en el informe", async () => {
    // El JSON de `codex mcp list --json` admite un nombre con saltos de línea
    // igual que una clave de configuración, y ese nombre viaja al id, al recurso
    // y al resumen del hallazgo nativo.
    const native = nativeRunner({
      codex: JSON.stringify([
        {
          name: `sano\n  ✔ ${CODEX_HOST}/mcps/native:qtc-cert — el servidor conecta`,
          enabled: true,
          auth_status: "ok",
        },
      ]),
    });

    const output = await createMcpsProvider({ native: { run: native.run } }).run(
      inputFor([targetHost(CODEX_HOST)]),
    );
    const [finding] = output.findings.filter((item) => item.resource.kind === "mcp-server");
    if (finding === undefined) throw new Error("la corrida no tradujo el servidor nativo");

    // Los campos que se muestran, aplanados; el id conserva el nombre entero por
    // la misma razón que del lado de los archivos: dos servidores distintos no
    // pueden colapsar en una fila.
    expect(finding.resource.name).not.toMatch(/[\n\r]/);
    expect(finding.summary).not.toMatch(/[\n\r]/);
    for (const evidence of finding.evidence) expect(evidence).not.toMatch(/[\n\r]/);
    expect(finding.resource.name).toContain("sano");
  });

  it("un nombre larguísimo se recorta en la proyección y avisa que el archivo manda", async () => {
    const enorme = `x${"y".repeat(400)}`;
    writeClaudeWorkspaceConfig({ [enorme]: { command: ghostBinary, args: [], env: {} } });
    const native = nativeRunner({ claude: "" });

    const output = await createMcpsProvider({ native: { run: native.run } }).run(
      inputFor([targetHost(CLAUDE_HOST)]),
    );
    const [finding] = output.findings.filter((item) => item.resource.kind === "mcp-entry");
    if (finding === undefined) throw new Error("la corrida no diagnosticó la entrada ajena");

    expect(finding.resource.name.length).toBeLessThan(enorme.length);
    expect(finding.evidence.join(" | ")).toContain("el archivo manda");
  });
});

describe("proveedor de MCPs — qué puede volver roja una corrida y qué no", () => {
  /** Un host cuyo directorio de configuración quedó sin runtime que lo use. */
  function residualHost(id: HarnessId): DoctorTargetHost {
    return {
      ...targetHost(id),
      status: "residual-config",
      runtime: { state: "missing", version: null },
    };
  }

  it("un host residual-config sin binario no vuelve roja una máquina sana", async () => {
    // Desinstalé Codex hace meses y quedó `~/.codex/`. Que su binario no esté es
    // el estado NORMAL de ese host, no un proveedor caído: contabilizarlo como
    // cobertura `unavailable` sacaba exit 1 —y rompía el build de CI— sobre un
    // entorno impecable, por un host que la persona ya no tiene.
    const native = nativeRunner({ claude: "", codex: { errorCode: "ENOENT" } });

    const output = await createMcpsProvider({ native: { run: native.run } }).run(
      inputFor([targetHost(CLAUDE_HOST), residualHost(CODEX_HOST)]),
    );

    expect(coverageAt(output, CODEX_HOST).state).toBe("skipped");
    // Y no se calla el porqué: la cobertura sigue diciendo qué no se pudo mirar.
    expect(coverageAt(output, CODEX_HOST).reason ?? "").toContain("no está en el PATH");
    expect(doctorVerdict(output.findings, output.coverage).exit_code).toBe(0);
  });

  it("un host residual-config cuyo binario SÍ contesta y falla sigue siendo un proveedor caído", async () => {
    // La otra mitad de la distinción: se perdona «no hay binario que preguntar»,
    // no «pregunté y no se pudo». Sin esto, la corrección de arriba pasaría con
    // un proveedor que perdona cualquier fallo de lectura del host residual.
    const native = nativeRunner({ claude: "", codex: { status: 2 } });

    const output = await createMcpsProvider({ native: { run: native.run } }).run(
      inputFor([targetHost(CLAUDE_HOST), residualHost(CODEX_HOST)]),
    );

    expect(coverageAt(output, CODEX_HOST).state).toBe("unavailable");
    expect(coverageAt(output, CODEX_HOST).reason ?? "").toContain("código 2");
    expect(doctorVerdict(output.findings, output.coverage).exit_code).toBe(1);
  });

  it("un archivo de configuración ilegible no puede quedar como cobertura comprobada", async () => {
    // Sin conexiones registradas y con `.mcp.json` roto a mano, la corrida
    // respondía `checked` con cero entradas miradas y veredicto 0: la cobertura
    // que dice «comprobada» sin haber mirado. El host, con ese archivo, no
    // levanta NINGÚN MCP —ni el descriptor de Workline, que tampoco se enumera—.
    writeFileSync(
      join(workspace, ".mcp.json"),
      '{ "mcpServers": { "ajeno": { "command": "npx" }, ',
    );
    const native = nativeRunner({ claude: "", codex: "[]" });

    const output = await createMcpsProvider({ native: { run: native.run } }).run(
      inputFor([targetHost(CLAUDE_HOST), targetHost(CODEX_HOST)]),
    );

    expect(coverageAt(output, CLAUDE_HOST).state).toBe("unavailable");
    expect(coverageAt(output, CLAUDE_HOST).reason ?? "").toContain(join(workspace, ".mcp.json"));
    expect(doctorVerdict(output.findings, output.coverage).exit_code).toBe(1);
    // Y el host cuyo archivo sí se leyó no se contagia.
    expect(coverageAt(output, CODEX_HOST).state).toBe("checked");
  });

  it("el mismo archivo bien formado vuelve a decir comprobada, y con su hallazgo", async () => {
    // La otra mitad del par: sin esto, la prueba de arriba pasaría con un
    // proveedor que declara `unavailable` siempre.
    writeClaudeWorkspaceConfig({ ajeno: { command: "npx", args: [], env: {} } });
    const native = nativeRunner({ claude: "" });

    const output = await createMcpsProvider({ native: { run: native.run } }).run(
      inputFor([targetHost(CLAUDE_HOST)]),
    );

    expect(coverageAt(output, CLAUDE_HOST).state).toBe("checked");
    expect(findingAt(output, entryId(CLAUDE_HOST, "workspace", "ajeno")).state).toBe("healthy");
  });

  it("la ruta absoluta de un binario se resuelve por el puerto de archivos, no por el disco de la máquina", async () => {
    // El binario EXISTE en el disco real de quien corre la suite; el puerto del
    // contexto dice que no. Con `existsSync` el hallazgo salía sano y el
    // resultado del doctor dependía de la máquina en vez del contexto.
    const realBinary = join(root, "bin", "mcp-instalado");
    mkdirSync(dirname(realBinary), { recursive: true });
    writeFileSync(realBinary, "#!/bin/sh\n");
    fsAnswers.set(realBinary, false);
    writeClaudeWorkspaceConfig({ "vendor-mcp": { command: realBinary, args: [], env: {} } });
    const native = nativeRunner({ claude: "" });

    const output = await createMcpsProvider({ native: { run: native.run } }).run(
      inputFor([targetHost(CLAUDE_HOST)]),
    );
    const finding = findingAt(output, entryId(CLAUDE_HOST, "workspace", "vendor-mcp"));

    expect(finding.state).toBe("warning");
    expect(finding.evidence.join(" | ")).toContain("no existe en esa ruta");
  });
});
