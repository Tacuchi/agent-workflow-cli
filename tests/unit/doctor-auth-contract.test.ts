import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createToolsAuthProvider } from "../../src/application/doctor/provider-tools-auth.js";
import { PathsService } from "../../src/application/paths-service.js";
import type { CliContext } from "../../src/cli/types.js";
import type { EffectClass } from "../../src/domain/capability/effects.js";
import {
  type DoctorAuthFlow,
  authFindingState,
  custodyViolation,
} from "../../src/domain/doctor/auth.js";
import { carriesSecretMaterial, redactSensitiveValue } from "../../src/domain/redaction.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";

/**
 * El contrato de autenticación: la custodia del secreto, y el único proveedor real.
 *
 * La promesa de esta fase es negativa y por eso hay que probarla por sus bordes:
 * el CLI NUNCA custodia la credencial. Lo que la sostiene son tres cosas, y cada
 * una se fija acá:
 *
 *  1. la forma del flujo no tiene dónde poner un secreto —no lleva entorno ni
 *     archivo—, así que lo único expresable es el `argv`, y `custodyViolation`
 *     lo ataja junto con las dos formas indirectas (un flujo que no hereda la
 *     terminal sólo puede leer el secreto de algo que le pase el CLI; uno que
 *     declara una clase que escribe sólo tendría la credencial para escribir);
 *  2. la guía nombra la VARIABLE y jamás su valor, y sigue siendo seguible
 *     después de la redacción —la línea que `buildEnvHelp` emite llega como
 *     `export DB_X_DSN=***` y quien la copie deja literalmente `***` en su
 *     archivo de arranque—;
 *  3. la verificación profunda exige autorización de red, y sin ella se DEGRADA
 *     diciéndolo en vez de callarse o de mentir.
 *
 * El valor del DSN que se siembra acá es inventado y no puede aparecer en
 * ninguna salida: es la premisa que hace no vacuas las aserciones de redacción.
 */

const CONNECTION = { name: "qtc-cert", dsnVar: "DB_CERT_DSN" };
const FAKE_DSN = "postgres://usuario:CLAVE-INVENTADA-9f3a@localhost:5432/cert";

/** El doble de la verificación de red: registra si la llamaron, y con qué. */
const connection = vi.hoisted(() => ({
  calls: [] as string[],
  result: { ok: true, source: "dsn.env" } as { ok: boolean; source: string | null; error?: string },
}));

/**
 * La forma que `buildEnvHelp` devuelve en Windows, para poder ejercitarla desde
 * cualquier plataforma.
 *
 * `buildEnvHelp` lee `process.platform`, así que la rama de Windows es
 * inalcanzable corriendo la suite en macOS o Linux — y es justamente donde la
 * guía se equivocaba: no hay ningún comando con `>>`, así que buscar un archivo
 * de arranque caía en un genérico y descartaba el único mecanismo durable que esa
 * plataforma tiene. Se dobla la FORMA y se ejercita la traducción real.
 */
const envHelp = vi.hoisted(() => ({ windows: false }));

vi.mock("../../src/application/self/mcp-config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/application/self/mcp-config.js")>();
  return {
    ...actual,
    buildEnvHelp: (dsnVar: string, name: string) =>
      envHelp.windows
        ? {
            platform: "windows",
            variable: dsnVar,
            commands: [
              `$env:${dsnVar} = "<DSN>"`,
              `[Environment]::SetEnvironmentVariable("${dsnVar}", "<DSN>", "User")`,
            ],
            next_step: `agent-workflow self mcp use-env --name ${name} --dsn-var ${dsnVar}`,
          }
        : actual.buildEnvHelp(dsnVar, name),
  };
});

vi.mock("../../src/application/mcp-test-connection-service.js", () => ({
  testMcpConnection: async (input: { dsnVar: string }) => {
    connection.calls.push(input.dsnVar);
    return connection.result;
  },
}));

const { dsnAuthProvider } = await import("../../src/application/doctor/auth-dsn.js");
const { DOCTOR_AUTH_PROVIDERS } = await import("../../src/application/doctor/auth-registry.js");

let root: string;
let home: string;
let ctx: CliContext;

beforeEach(() => {
  envHelp.windows = false;
  connection.calls.length = 0;
  connection.result = { ok: true, source: "dsn.env" };
  root = mkdtempSync(join(tmpdir(), "doctor-auth-"));
  home = join(root, "home");
  const dev = join(home, ".workflow", "dev");
  mkdirSync(dev, { recursive: true });
  writeFileSync(
    join(dev, "mcp-connections.json"),
    `${JSON.stringify({
      version: 2,
      connections: [{ ...CONNECTION, provider: "postgres" }],
    })}\n`,
  );
  ctx = {
    env: new FakeEnv(home, home),
    paths: new PathsService(normalizeNamespace("workflow"), home, home),
  } as unknown as CliContext;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function seedDsn(): void {
  writeFileSync(join(home, ".workflow", "dev", "dsn.env"), `${CONNECTION.dsnVar}=${FAKE_DSN}\n`);
}

/** Un flujo sano: hereda la terminal y sólo corre un programa. */
function flowOf(overrides: Partial<DoctorAuthFlow> = {}): DoctorAuthFlow {
  return {
    kind: "command",
    argv: ["login-de-prueba", "--sujeto", "uno"],
    interactive: true,
    effects: ["execute"],
    ...overrides,
  };
}

describe("la custodia de un flujo declarado", () => {
  it("un flujo interactivo que sólo ejecuta pasa", () => {
    expect(custodyViolation(flowOf())).toBeNull();
  });

  it("un flujo que además sale a la red pasa: un login remoto es lo que un login hace", () => {
    // El defecto que atrapa por el otro lado: una regla que sólo aceptara
    // `execute` bloquearía todo login real, y entonces la custodia se cumpliría
    // por no tener nunca ningún flujo — una promesa vacía en vez de una regla.
    expect(custodyViolation(flowOf({ effects: ["execute", "network_external"] }))).toBeNull();
  });

  it("un flag que PIDE una credencial se bloquea, con o sin valor pegado", () => {
    // El defecto que atrapa: un argumento queda en la tabla de procesos de la
    // máquina y en el historial del shell. Ahí el secreto ya se filtró antes de
    // que el programa arranque, así que el bloqueo tiene que ser por la FORMA
    // del flag y no por si trae valor.
    for (const token of ["--token", "--token=abc123", "--password", "--dsn", "-key"]) {
      const reason = custodyViolation(flowOf({ argv: ["login", token, "x"] }));
      expect(reason, `${token} no se bloqueó`).not.toBeNull();
      expect(reason).toContain("argumento");
    }
  });

  it("los nombres COMPUESTOS de credencial también se bloquean, no sólo los cortos", () => {
    // El defecto que atrapa, y que estaba vivo: la lista literal de flags era más
    // angosta que la lista de claves sensibles del propio redactor, así que
    // `--token` bloqueaba y `--access-token` pasaba — la diferencia entre
    // filtrar la credencial y no filtrarla era qué palabra eligió el autor del
    // proveedor. Con el flujo pasando, el lote se sellaba, la vista previa
    // imprimía el token literal y el ejecutor lo dejaba en la tabla de procesos.
    for (const token of [
      "--access-token",
      "--client-secret",
      "--with-token",
      "--api-token",
      "--credentials",
      "--credential",
      "--private-key",
      "--connection-string",
      "--database-url",
      "--apikey",
    ]) {
      const reason = custodyViolation(flowOf({ argv: ["login", token, "x"] }));
      expect(reason, `${token} no se bloqueó`).not.toBeNull();
    }
  });

  it("un flag que no dice qué transporta pasa la lista de nombres, y por eso NO es la única defensa", () => {
    // La honestidad del residuo: ninguna lista de nombres puede saber que `--pat`
    // pide un token. Lo que ataja ese caso es la otra regla —el flujo tiene que
    // heredar la terminal—, porque un programa interactivo no necesita el secreto
    // en la línea de comandos. Esta prueba fija el límite en vez de dejar creer
    // que la lista es completa.
    expect(custodyViolation(flowOf({ argv: ["login", "--pat", "x"] }))).toBeNull();
    expect(
      custodyViolation(flowOf({ argv: ["login", "--pat", "x"], interactive: false })),
    ).not.toBeNull();
  });

  it("un argumento con forma de credencial se bloquea aunque el flag sea inocente", () => {
    // El otro camino del mismo predicado: `--url postgres://u:clave@h/db` no
    // tiene un flag sospechoso, y lleva la credencial completa.
    const reason = custodyViolation(
      flowOf({ argv: ["login", "--url", "postgres://u:secreta@host:5432/db"] }),
    );
    expect(reason).not.toBeNull();
  });

  it("un flujo que NO hereda la terminal se bloquea nombrando el entorno y el archivo", () => {
    // El defecto que atrapa: un programa sin terminal no tiene de dónde leer la
    // credencial salvo de lo que el CLI le pase. Aceptarlo sería mover la
    // custodia al CLI sin que nadie lo decidiera.
    const reason = custodyViolation(flowOf({ interactive: false }));
    expect(reason).not.toBeNull();
    expect(reason).toContain("entorno");
    expect(reason).toContain("archivo");
  });

  it("un flujo que declara una clase que ESCRIBE se bloquea, y la nombra", () => {
    for (const effect of ["local_additive", "mutate_overwrite", "destructive"] as EffectClass[]) {
      const reason = custodyViolation(flowOf({ effects: ["execute", effect] }));
      expect(reason, `${effect} no se bloqueó`).not.toBeNull();
      expect(reason).toContain(effect);
    }
  });

  it("un flag que pide credencial y viene SIN valor también cuenta como material", () => {
    // La mitad de `carriesSecretMaterial` que el redactor no cubre: éste sólo
    // reescribe una asignación cuando ve un VALOR después, así que un `--token=`
    // pelado le pasa por al lado. Y sigue siendo una petición de credencial.
    expect(carriesSecretMaterial("--token=")).toBe(true);
    expect(carriesSecretMaterial("dsn=")).toBe(true);
    // Y lo que no tiene forma de credencial no se marca: un predicado que dijera
    // sí a todo bloquearía cualquier flujo y la custodia se cumpliría por no
    // existir.
    expect(carriesSecretMaterial("--sujeto")).toBe(false);
    expect(carriesSecretMaterial("login")).toBe(false);
  });

  it("un flujo sin programa se bloquea en vez de correr algo inventado", () => {
    expect(custodyViolation(flowOf({ argv: [] }))).not.toBeNull();
  });

  it("el estado de autenticación mapea a un estado de hallazgo, y `unverified` no es sano", () => {
    expect(authFindingState("present")).toBe("healthy");
    expect(authFindingState("absent")).toBe("warning");
    // El fail-closed: «no se pudo concluir» nunca se presenta como comprobado.
    expect(authFindingState("unverified")).toBe("unverified");
  });
});

describe("el registro real de proveedores de autenticación", () => {
  it("NINGÚN proveedor real declara flujo, y el catálogo lo dice", () => {
    // La aserción que documenta la decisión: la maquinaria de flujos existe y
    // está probada con un doble, y en producción no corre nada porque nadie
    // declara nada. Si algún día un proveedor real declara un flujo, esta prueba
    // cae y el cambio pasa por la mano de quien lo decidió.
    for (const provider of DOCTOR_AUTH_PROVIDERS) {
      for (const subject of provider.subjects(ctx)) {
        expect(provider.flow(subject, ctx), `${provider.id} declara un flujo`).toBeNull();
      }
    }
  });

  it("los ids de proveedor son únicos", () => {
    // Lo que protege hoy: el id viaja en los argumentos de la acción y se imprime
    // en la vista previa y en la guía. Dos proveedores homónimos harían
    // indistinguibles dos flujos distintos en la única pantalla donde la persona
    // decide si aprueba.
    const ids = DOCTOR_AUTH_PROVIDERS.map((provider) => provider.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("los ids de sujeto son únicos en TODO el registro, no sólo dentro de cada proveedor", () => {
    // El id del sujeto es la identidad del hallazgo: dos iguales colapsan en una
    // fila y el informe pierde uno sin decirlo.
    const ids = DOCTOR_AUTH_PROVIDERS.flatMap((provider) =>
      provider.subjects(ctx).map((subject) => subject.id),
    );
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("el proveedor DSN", () => {
  it("sus sujetos son las conexiones registradas, y nombran la variable sin su valor", () => {
    seedDsn();
    const [subject] = dsnAuthProvider.subjects(ctx);

    expect(dsnAuthProvider.subjects(ctx)).toHaveLength(1);
    expect(subject.label).toBe(CONNECTION.dsnVar);
    // El locator es el ARCHIVO donde vive, nunca lo que hay dentro.
    expect(subject.locator).toBe(ctx.paths.userDsnFile());
    expect(JSON.stringify(subject)).not.toContain("CLAVE-INVENTADA-9f3a");
  });

  it("`check` lee presente cuando la variable está y ausente cuando no", async () => {
    const [subject] = dsnAuthProvider.subjects(ctx);
    expect((await dsnAuthProvider.check(subject, ctx)).state).toBe("absent");

    seedDsn();
    const present = await dsnAuthProvider.check(subject, ctx);
    expect(present.state).toBe("present");
    expect(present.evidence.join(" | ")).toContain(CONNECTION.dsnVar);
    // Y no salió de la máquina para decirlo.
    expect(connection.calls).toEqual([]);
  });

  it("declara que su verificación profunda exige salir de la máquina", () => {
    // El campo no es documentación: quien recorre el registro lo hace valer, y
    // `run` sólo se llama cuando esa clase está concedida. Por eso el proveedor
    // no repite el control adentro.
    expect(dsnAuthProvider.verify.authorization).toBe("network_external");
  });

  it("sin la autorización de red la observación se DEGRADA y nadie se conecta", async () => {
    // El defecto que atrapa: una verificación que se degrada en silencio se lee
    // como una que corrió. Se prueba por el recorrido del registro —el único
    // llamador de `verify`— porque es ahí donde vive la regla; pedírselo al
    // proveedor a mano ejercitaría un camino que producción no puede tomar.
    seedDsn();
    const output = await createToolsAuthProvider({ providers: [dsnAuthProvider] }).run({
      ctx,
      hosts: [],
      hostStates: [],
      currentHost: null,
      workspaceDir: home,
      skipNative: false,
      verifyAuthorization: [],
    });

    expect(connection.calls).toEqual([]);
    expect(output.findings[0].state).toBe("healthy");
    expect(output.findings[0].evidence.join(" | ")).toContain("NO corrió");
    expect(output.findings[0].evidence.join(" | ")).toContain("network_external");
  });

  it("con la autorización de red corre el SELECT 1 sobre la variable exacta", async () => {
    seedDsn();
    const output = await createToolsAuthProvider({ providers: [dsnAuthProvider] }).run({
      ctx,
      hosts: [],
      hostStates: [],
      currentHost: null,
      workspaceDir: home,
      skipNative: false,
      verifyAuthorization: ["network_external"],
    });

    expect(connection.calls).toEqual([CONNECTION.dsnVar]);
    expect(output.findings[0].state).toBe("healthy");
  });

  it("una credencial que está y NO sirve queda `unverified`, ni presente ni ausente", async () => {
    // El corazón de AC-12 en esta categoría: la variable existe, así que
    // «ausente» sería falso; el servicio la rechazó, así que «presente» sería la
    // falsa salud. Las dos cosas van en la evidencia y el estado es el tercero.
    seedDsn();
    connection.result = { ok: false, source: "dsn.env", error: "autenticación rechazada" };
    const [subject] = dsnAuthProvider.subjects(ctx);

    const result = await dsnAuthProvider.verify.run(subject, ctx, ["network_external"]);

    expect(result.state).toBe("unverified");
    expect(result.evidence.join(" | ")).toContain("presente");
    expect(result.evidence.join(" | ")).toContain("autenticación rechazada");
  });

  it("con la variable ausente `verify` no intenta conectarse a nada", async () => {
    const [subject] = dsnAuthProvider.subjects(ctx);

    const result = await dsnAuthProvider.verify.run(subject, ctx, ["network_external"]);

    expect(result.state).toBe("absent");
    expect(connection.calls).toEqual([]);
  });

  it("en Windows la guía nombra el mecanismo durable, no un archivo que no existe", () => {
    // El defecto que atrapa: `buildEnvHelp` sólo nombra un archivo de arranque en
    // la rama *nix. Buscarlo igual dejaba la guía diciendo «dejala en tu archivo
    // de arranque (el de tu shell)» —algo que en Windows no existe— y tirando el
    // único paso que hace durable la variable ahí. El comando literal no se
    // releva: es una asignación, y el redactor lo entrega con `***` donde iba el
    // valor.
    envHelp.windows = true;
    const [subject] = dsnAuthProvider.subjects(ctx);

    const guidance = redactSensitiveValue(dsnAuthProvider.guidance(subject, ctx)) as string[];
    const joined = guidance.join(" | ");

    expect(joined).toContain("SetEnvironmentVariable");
    expect(joined).toContain("User");
    expect(joined).not.toContain("archivo de arranque");
    expect(joined).not.toContain("***");
    expect(joined).toContain(CONNECTION.dsnVar);
  });

  it("la guía nombra la variable, sobrevive a la redacción y no lleva ningún valor", () => {
    seedDsn();
    const [subject] = dsnAuthProvider.subjects(ctx);

    const guidance = dsnAuthProvider.guidance(subject, ctx) as string[];
    const redacted = redactSensitiveValue(guidance) as string[];

    expect(redacted.join(" | ")).toContain(CONNECTION.dsnVar);
    // Ninguna línea puede quedar con un `***` donde iba una palabra: quien copie
    // esa línea deja la credencial inválida en vez de ausente, y el diagnóstico
    // siguiente es peor que el de ahora.
    for (const line of redacted) expect(line).not.toContain("***");
    // Y el comando que propone tiene que ser VÁLIDO: `--name` lleva el nombre de
    // la conexión y nada más. Un `toContain(name)` suelto no alcanza — el mutante
    // que pasa el id entero del sujeto propone `--name env:qtc-cert`, que
    // `validateMcpInstance` rechaza, y la única línea accionable del hallazgo
    // queda siendo un comando que el propio CLI se niega a correr.
    expect(redacted.join(" | ")).toContain(`--name ${CONNECTION.name} `);
    expect(JSON.stringify(redacted)).not.toContain("CLAVE-INVENTADA-9f3a");
  });
});
