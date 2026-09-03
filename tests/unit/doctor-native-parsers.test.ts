import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  NATIVE_READ_TIMEOUT_MS,
  type NativeHostRunResult,
  type NativeMcpHost,
  parseClaudeMcpList,
  parseCodexMcpList,
  readNativeMcpState,
} from "../../src/application/doctor/native-host-state.js";

/**
 * Los lectores nativos son la única parte del doctor que no controla su entrada:
 * la escriben `codex mcp list --json` y `claude mcp list`, dos formatos ajenos
 * que cambian sin avisar. Por eso todo lo de acá se prueba contra las capturas
 * REALES congeladas en tests/fixtures/doctor/, y no contra strings inventados
 * que reflejen lo que el parser ya hace.
 *
 * La regla que ordena el archivo es fail-closed: un servidor cuya salud no se
 * pudo LEER queda `unverified`. Un doctor que adivina "connected" ante un
 * formato desconocido es peor que uno que admite que no pudo mirar, porque
 * convierte un problema real del usuario en un tilde verde.
 */

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../fixtures/doctor/${name}`, import.meta.url)), "utf8");

const CODEX_FIXTURE = fixture("codex-mcp-list.json");
const CLAUDE_FIXTURE = fixture("claude-mcp-list.txt");

// Transcritos a mano del fixture congelado: la expectativa viene de la captura,
// nunca de la salida del parser.
const CODEX_NAMES = [
  "agent-workflow",
  "computer-use",
  "context7",
  "figma",
  "node_repl",
  "openaiDeveloperDocs",
  "qtc-cert",
  "qtc-prod",
];

const CLAUDE_NAMES = [
  "plugin:context7:context7",
  "plugin:figma:figma",
  "plugin:firebase:firebase",
  "plugin:telegram:telegram",
  "qtc-cert",
  "qtc-prod",
];

function okServers(read: ReturnType<typeof parseCodexMcpList>) {
  if (!read.ok) throw new Error(`se esperaba una lectura ok, llegó: ${read.reason}`);
  return read.servers;
}

function byName(read: ReturnType<typeof parseCodexMcpList>, name: string) {
  const found = okServers(read).find((server) => server.name === name);
  if (found === undefined) throw new Error(`el fixture ya no trae el servidor '${name}'`);
  return found;
}

describe("parseCodexMcpList sobre la captura real de `codex mcp list --json`", () => {
  it("devuelve los ocho servidores del fixture con sus nombres", () => {
    const read = parseCodexMcpList(CODEX_FIXTURE);
    expect(okServers(read).map((server) => server.name)).toEqual(CODEX_NAMES);
  });

  it("un servidor apagado a propósito queda disabled, no failed", () => {
    // `computer-use` tiene enabled:false en la captura. Plegarlo a "failed"
    // pondría una advertencia roja sobre algo que la persona apagó ella misma,
    // y el doctor pasaría a pedir que se arregle lo que no está roto.
    const raw = JSON.parse(CODEX_FIXTURE) as { name: string; enabled: unknown }[];
    expect(raw.find((entry) => entry.name === "computer-use")?.enabled).toBe(false);

    expect(byName(parseCodexMcpList(CODEX_FIXTURE), "computer-use").health).toBe("disabled");
  });

  it("auth_status not_logged_in queda needs-auth aunque el servidor esté habilitado", () => {
    // Codex reporta disponibilidad y credenciales por separado: `figma` está
    // enabled:true y sin sesión. Es accionable por la persona (loguearse), y por
    // eso no se puede confundir ni con "connected" ni con "failed".
    const raw = JSON.parse(CODEX_FIXTURE) as { name: string; auth_status: unknown }[];
    expect(raw.find((entry) => entry.name === "figma")?.auth_status).toBe("not_logged_in");

    const figma = byName(parseCodexMcpList(CODEX_FIXTURE), "figma");
    expect(figma.health).toBe("needs-auth");
    expect(figma.auth_status).toBe("not_logged_in");
  });

  it("los habilitados con auth_status unsupported quedan connected", () => {
    // "unsupported" significa que ese transporte no tiene noción de login, no
    // que falte autenticar. Tratarlo como needs-auth marcaría siete de ocho
    // servidores sanos como pendientes.
    // La premisa —quiénes están habilitados y con auth_status "unsupported"— se
    // lee del fixture CRUDO. Derivarla de `okServers(...)` haría que un parser
    // que perdiera `enabled` o `auth_status` siguiera cumpliendo su propia
    // premisa, y la exclusión de `computer-use` escondería dentro del filtro un
    // dato de la captura que tiene que estar a la vista.
    const raw = JSON.parse(CODEX_FIXTURE) as {
      name: string;
      enabled: unknown;
      auth_status: unknown;
    }[];
    const connected = raw
      .filter((entry) => entry.enabled === true && entry.auth_status === "unsupported")
      .map((entry) => entry.name);
    expect(connected).toEqual([
      "agent-workflow",
      "context7",
      "node_repl",
      "openaiDeveloperDocs",
      "qtc-cert",
      "qtc-prod",
    ]);

    const read = parseCodexMcpList(CODEX_FIXTURE);
    for (const name of connected) {
      expect(byName(read, name).health).toBe("connected");
      // El informe también muestra el auth_status: un parser que dejara de
      // leerlo seguiría dando la salud correcta acá y publicaría la columna
      // vacía. La premisa cruda no lo cubre sola, así que se afirma aparte.
      expect(byName(read, name).auth_status).toBe("unsupported");
    }
  });

  it("el transporte se lee del objeto anidado y llega como string", () => {
    // En la captura `transport` es un objeto ({type:"stdio"} / {type:"streamable_http"}).
    // El informe necesita el tipo suelto; dejar el objeto lo volvería "[object Object]".
    const read = parseCodexMcpList(CODEX_FIXTURE);
    expect(byName(read, "agent-workflow").transport).toBe("stdio");
    expect(byName(read, "figma").transport).toBe("streamable_http");
  });

  it("fail-closed: sin campo enabled, o con enabled no booleano, queda unverified", () => {
    // El día que Codex renombre o retipe `enabled`, el parser no puede seguir
    // declarando sano lo que ya no sabe leer. Es el caso que separa un doctor
    // honesto de uno que miente en verde.
    const read = parseCodexMcpList(
      JSON.stringify([
        { name: "sin-campo", auth_status: "unsupported" },
        { name: "enabled-string", enabled: "true", auth_status: "unsupported" },
        { name: "enabled-uno", enabled: 1, auth_status: "unsupported" },
      ]),
    );
    expect(okServers(read).map((server) => server.health)).toEqual([
      "unverified",
      "unverified",
      "unverified",
    ]);
  });

  it("una salida que no es JSON se rechaza con motivo, no se devuelve vacía", () => {
    // Una lista vacía y una salida ilegible son cosas distintas: la primera dice
    // "no hay servidores", la segunda "no pude mirar". Confundirlas borraría del
    // informe ocho servidores que sí existen.
    const read = parseCodexMcpList("codex: command failed\n");
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error("inalcanzable");
    expect(read.host).toBe("codex");
    expect(read.reason.length).toBeGreaterThan(0);
  });

  it("un JSON válido que no es lista también se rechaza", () => {
    const read = parseCodexMcpList('{"servers":[]}');
    expect(read.ok).toBe(false);
  });
});

describe("parseClaudeMcpList sobre la captura real de `claude mcp list`", () => {
  it("los nombres de plugin conservan sus dos puntos internos", () => {
    // `plugin:context7:context7` se parte en tres por ":". Cortar por el PRIMERO
    // —lo natural al mirar "name: comando"— llamaría "plugin" a los cuatro
    // servidores de plugin y el informe mostraría un nombre repetido cuatro
    // veces, imposible de accionar.
    const read = parseClaudeMcpList(CLAUDE_FIXTURE);
    const names = okServers(read).map((server) => server.name);
    expect(names).toEqual(CLAUDE_NAMES);
    expect(names).toContain("plugin:context7:context7");
    expect(names).not.toContain("plugin");
  });

  it("traduce las marcas conocidas a salud y conserva el texto del host", () => {
    const read = parseClaudeMcpList(CLAUDE_FIXTURE);
    const context7 = byName(read, "plugin:context7:context7");
    expect(context7.health).toBe("connected");
    expect(context7.detail).toBe("Connected");

    const figma = byName(read, "plugin:figma:figma");
    expect(figma.health).toBe("needs-auth");
    expect(figma.detail).toBe("Needs authentication");

    // El detalle del deshabilitado es lo único que le dice a la persona cómo
    // revertirlo; perderlo dejaría un "disabled" sin salida.
    const telegram = byName(read, "plugin:telegram:telegram");
    expect(telegram.health).toBe("disabled");
    expect(telegram.detail).toBe("Disabled for this project (re-enable via /mcp)");
  });

  it("el encabezado y las líneas vacías no producen servidores", () => {
    // "Checking MCP server health…" abre la salida real. Si entrara como
    // servidor, el informe tendría un fantasma llamado "Checking" que nadie
    // puede arreglar.
    expect(CLAUDE_FIXTURE).toContain("Checking MCP server health");
    const names = okServers(parseClaudeMcpList(CLAUDE_FIXTURE)).map((server) => server.name);
    expect(names).toHaveLength(CLAUDE_NAMES.length);
    expect(names.some((name) => name.startsWith("Checking"))).toBe(false);
  });

  it("fail-closed: una marca desconocida queda unverified y no contamina el resto", () => {
    // Claude imprime prosa sin contrato: la marca de "necesita autenticación" ya
    // cambió una vez entre versiones. Ante un símbolo que no está en la tabla,
    // la única respuesta segura es admitir que no se pudo leer —y las líneas
    // conocidas de la misma salida tienen que seguir leyéndose igual.
    const read = parseClaudeMcpList(`${CLAUDE_FIXTURE}raro: cmd - ~ Something else\n`);
    const raro = byName(read, "raro");
    expect(raro.health).toBe("unverified");
    expect(raro.detail).toBe("~ Something else");
    expect(byName(read, "qtc-prod").health).toBe("connected");
  });

  it("las marcas de repuesto de la tabla también traducen, no sólo las del fixture", () => {
    // La tabla de producción lleva SIETE marcas y la captura de hoy ejercita
    // cuatro ('✔', '!', '⊘', '✘'). Las otras tres están ahí justamente porque
    // claude ya cambió de símbolo una vez entre versiones: son las que ningún
    // fixture va a cubrir y las únicas que van a importar el día que cambie.
    // Un símbolo mal copiado o una salud cruzada en cualquiera de esas filas se
    // publicaría en verde sin esta prueba.
    // La expectativa es el contrato declarado acá, no la tabla importada.
    const DE_REPUESTO = [
      { mark: "⏸", health: "needs-auth" },
      { mark: "✓", health: "connected" },
      { mark: "✗", health: "failed" },
    ] as const;
    const lineas = DE_REPUESTO.map(
      (fila, indice) => `repuesto${indice}: cmd - ${fila.mark} Texto del host ${indice}`,
    ).join("\n");
    const read = parseClaudeMcpList(`${lineas}\n`);
    DE_REPUESTO.forEach((fila, indice) => {
      const server = byName(read, `repuesto${indice}`);
      expect(server.health).toBe(fila.health);
      expect(server.detail).toBe(`Texto del host ${indice}`);
    });
  });

  it("una línea de fallo queda failed con el motivo del host en el detalle", () => {
    const read = parseClaudeMcpList(`${CLAUDE_FIXTURE}roto: cmd - ✘ Failed to connect: motivo\n`);
    const roto = byName(read, "roto");
    expect(roto.health).toBe("failed");
    expect(roto.detail).toBe("Failed to connect: motivo");
  });

  it("no retiene el comando ni la URL del medio en el detalle", () => {
    // Entre el nombre y la marca va la línea de comando completa del host: rutas
    // absolutas de node_modules, tokens de entorno, URLs. No es información de
    // salud, es del host, y arrastrarla haría ilegible cada fila del informe.
    const read = parseClaudeMcpList(CLAUDE_FIXTURE);
    expect(byName(read, "qtc-cert").detail).toBe("Connected");

    // El corte tiene que ser por el ÚLTIMO " - ": un comando puede traer ese
    // mismo separador adentro (un `bash -c` con una frase, un flag con guion
    // suelto). Cortando por el primero, el estado leído sería
    // "bar' - ✓ Connected", ninguna marca conocida lo abriría y el servidor
    // caería a 'unverified': un servidor sano reportado como ilegible.
    const interno = byName(
      parseClaudeMcpList("interno: bash -c 'foo - bar' - ✔ Connected\n"),
      "interno",
    );
    expect(interno.health).toBe("connected");
    expect(interno.detail).toBe("Connected");

    for (const server of okServers(read)) {
      expect(server.detail ?? "").not.toContain("/Users/");
      expect(server.detail ?? "").not.toContain("http");
      expect(server.detail ?? "").not.toContain("npx");
    }
  });
});

interface RunnerCall {
  command: string;
  args: readonly string[];
  timeoutMs: number;
}

function recordingRunner(result: NativeHostRunResult): {
  calls: RunnerCall[];
  run: (command: string, args: readonly string[], timeoutMs: number) => NativeHostRunResult;
} {
  const calls: RunnerCall[] = [];
  return {
    calls,
    run: (command, args, timeoutMs) => {
      calls.push({ command, args, timeoutMs });
      return result;
    },
  };
}

const OK_RUN = (stdout: string): NativeHostRunResult => ({
  status: 0,
  stdout,
  errorCode: null,
  timedOut: false,
});

function refusal(host: NativeMcpHost, result: NativeHostRunResult): string {
  const read = readNativeMcpState(host, { run: recordingRunner(result).run });
  if (read.ok) throw new Error(`se esperaba un rechazo, llegó ok con ${read.servers.length}`);
  expect(read.host).toBe(host);
  return read.reason;
}

/**
 * Los TRES motivos de rechazo interpolan el nombre del host, así que
 * `toContain("claude")` los satisface a todos por igual: no distingue nada.
 * Cada modo se fija acá por su texto PROPIO, y además se afirma que los tres
 * son distintos entre sí con el mismo host y el mismo `status` (null), que es
 * el par que colapsa si alguien borra una rama: sin el branch de ENOENT, un
 * binario que no existe se informa como "terminó con código desconocido".
 */
const AUSENTE: NativeHostRunResult = {
  status: null,
  stdout: "",
  errorCode: "ENOENT",
  timedOut: false,
};
const COLGADO: NativeHostRunResult = { status: null, stdout: "", errorCode: null, timedOut: true };
const CAIDO_SIN_CODIGO: NativeHostRunResult = {
  status: null,
  stdout: "",
  errorCode: "EACCES",
  timedOut: false,
};

describe("parseClaudeMcpList ante una salida que no es un listado", () => {
  it("una línea de error con forma de servidor sale unverified, jamás conectada", () => {
    // `claude mcp list` no tiene contrato: si algún día sale con código 0 e
    // imprime un error, su primer token igual termina en dos puntos y el parser
    // no puede distinguirlo de un servidor. Lo que SÍ está garantizado es hacia
    // qué lado falla: sin marca conocida el estado es `unverified` y el texto
    // del error viaja como detalle, así que el informe muestra un hallazgo «no
    // pude concluir» con la causa a la vista — nunca uno sano.
    const read = parseClaudeMcpList("Error: no config found - check your setup\n");
    if (!read.ok) throw new Error("el parser de claude nunca devuelve ok:false");

    expect(read.servers).toHaveLength(1);
    const [phantom] = read.servers;
    expect(phantom.health).toBe("unverified");
    expect(phantom.health).not.toBe("connected");
    expect(phantom.detail).toBe("check your setup");
  });

  it("una salida vacía no inventa servidores", () => {
    const read = parseClaudeMcpList("");
    if (!read.ok) throw new Error("el parser de claude nunca devuelve ok:false");
    expect(read.servers).toEqual([]);
  });
});

describe("readNativeMcpState", () => {
  it("un host no instalado se rechaza nombrando el binario y el PATH", () => {
    // Es el caso más común de todos —el usuario no tiene ese host— y el informe
    // tiene que poder decir CUÁL falta y por qué, no "algo falló". "PATH" es la
    // única palabra que este motivo no comparte con los otros dos.
    const ausente = refusal("claude", AUSENTE);
    expect(ausente).toContain("claude");
    expect(ausente).toContain("PATH");
  });

  it("un host que se cuelga lo dice por el límite, no por un código", () => {
    // `claude mcp list` conecta cada servidor para reportarlo, así que colgarse
    // es un desenlace esperable. La acción de la persona es distinta a la de un
    // binario ausente, así que el motivo tiene que nombrar el límite de tiempo.
    expect(refusal("claude", COLGADO)).toContain("límite");
  });

  it("los tres modos de rechazo dan motivos distintos entre sí", () => {
    // Mismo host y mismo `status: null` en los tres: lo único que puede
    // separarlos es que cada rama escriba su propio motivo. Si una rama
    // desaparece, dos de estos colapsan en el mismo texto genérico y el doctor
    // informa "terminó con código desconocido" sobre un binario que ni existe.
    const ausente = refusal("claude", AUSENTE);
    const colgado = refusal("claude", COLGADO);
    const caido = refusal("claude", CAIDO_SIN_CODIGO);
    expect(new Set([ausente, colgado, caido]).size).toBe(3);
    expect(ausente).not.toBe(caido);
  });

  it("clasifica el rechazo: sólo el binario ausente es 'absent', los demás son 'failed'", () => {
    // El motivo en prosa no alcanza para decidir cobertura. Un host
    // `residual-config` —un directorio de configuración que quedó sin runtime—
    // NO tiene binario por definición, así que su lectura fallida no es un
    // proveedor caído; sin esta clasificación, un directorio huérfano de un host
    // desinstalado meses atrás dejaba la cobertura en `unavailable` y sacaba
    // exit 1 sobre un entorno impecable. Colgarse o contestar mal sí son fallas:
    // ahí el binario está y la pregunta no funcionó.
    const failureOf = (host: NativeMcpHost, result: NativeHostRunResult): string => {
      const read = readNativeMcpState(host, { run: recordingRunner(result).run });
      if (read.ok) throw new Error("se esperaba un rechazo");
      return read.failure;
    };

    expect(failureOf("claude", AUSENTE)).toBe("absent");
    expect(failureOf("claude", COLGADO)).toBe("failed");
    expect(failureOf("claude", CAIDO_SIN_CODIGO)).toBe("failed");
    expect(failureOf("codex", { status: 2, stdout: "", errorCode: null, timedOut: false })).toBe(
      "failed",
    );
    // Y una salida que el parser de codex no puede leer tampoco es un host ausente.
    expect(
      failureOf("codex", { status: 0, stdout: "no soy json", errorCode: null, timedOut: false }),
    ).toBe("failed");
  });

  it("un código de salida distinto de cero se rechaza mencionándolo", () => {
    expect(
      refusal("codex", { status: 3, stdout: "[]", errorCode: null, timedOut: false }),
    ).toContain("3");
  });

  it("fail-closed: una salida con error de spawn no se parsea aunque traiga stdout", () => {
    // Un spawn fallido puede dejar stdout parcial. Parsearlo devolvería una
    // lista corta como si fuera la verdad del host.
    expect(
      refusal("codex", {
        status: null,
        stdout: CODEX_FIXTURE,
        errorCode: "SPAWN_FAILED",
        timedOut: false,
      }).length,
    ).toBeGreaterThan(0);
  });

  it("el techo de lectura es una cota acotada de verdad, no cualquier número", () => {
    // Las dos pruebas de invocación comparan `timeoutMs` contra la constante
    // importada del módulo bajo prueba: fijan el CABLEADO (que el techo llega
    // al runner) y ninguna de las dos se entera si el techo pasa a 0 ms —todo
    // se declara colgado— o a quince horas —el doctor retiene el informe
    // entero—. La cota tiene que alcanzar para que claude conecte cada servidor
    // y caber en la paciencia de una fase de diagnóstico.
    expect(NATIVE_READ_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
    expect(NATIVE_READ_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });

  it("codex se invoca con --json y su salida va al parser de codex", () => {
    const runner = recordingRunner(OK_RUN(CODEX_FIXTURE));
    const read = readNativeMcpState("codex", { run: runner.run });
    expect(runner.calls).toEqual([
      { command: "codex", args: ["mcp", "list", "--json"], timeoutMs: NATIVE_READ_TIMEOUT_MS },
    ]);
    expect(okServers(read).map((server) => server.name)).toEqual(CODEX_NAMES);
    expect(okServers(read).every((server) => server.host === "codex")).toBe(true);
  });

  it("claude se invoca sin --json y su salida va al parser de prosa", () => {
    // Pedirle `--json` a claude no falla: imprime la misma prosa, y el parser de
    // codex la rechazaría entera. El par host↔argumentos es load-bearing.
    const runner = recordingRunner(OK_RUN(CLAUDE_FIXTURE));
    const read = readNativeMcpState("claude", { run: runner.run });
    expect(runner.calls).toEqual([
      { command: "claude", args: ["mcp", "list"], timeoutMs: NATIVE_READ_TIMEOUT_MS },
    ]);
    expect(okServers(read).map((server) => server.name)).toEqual(CLAUDE_NAMES);
    expect(okServers(read).every((server) => server.host === "claude")).toBe(true);
  });
});
