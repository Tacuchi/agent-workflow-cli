import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toolsAuthProvider } from "../../src/application/doctor/provider-tools-auth.js";
import type { DoctorProviderInput } from "../../src/application/doctor/types.js";
import { PathsService } from "../../src/application/paths-service.js";
import type { CliContext } from "../../src/cli/types.js";
import { redactSensitiveValue } from "../../src/domain/redaction.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";

/**
 * La categoría herramientas/autenticación, y su tensión propia.
 *
 * Tiene que NOMBRAR la variable de entorno —es lo único accionable que puede
 * ofrecer— y a la vez pasar por la misma redacción que protege todas las
 * salidas. Las dos cosas se pelean: `redactSensitiveText` lee cualquier
 * `…_DSN` seguido de `=`, `:` o un espacio como una asignación y borra lo que
 * viene después. Un informe que decía «DB_CERT_DSN está visible» salía como
 * «DB_CERT_DSN *** visible», y el hallazgo cuyo trabajo es explicar qué exportar
 * se volvía ilegible justo ahí.
 */

const CONNECTION = { name: "qtc-cert", dsnVar: "DB_CERT_DSN" };
/** Valor inventado con forma de DSN: no puede aparecer en ninguna salida. */
const FAKE_DSN = "postgres://usuario:CLAVE-INVENTADA-9f3a@localhost:5432/cert";

let root: string;
let home: string;
let workspace: string;
let ctx: CliContext;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "doctor-tools-auth-"));
  home = join(root, "home");
  workspace = join(root, "ws");
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });
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
    env: new FakeEnv(home, workspace),
    paths: new PathsService(normalizeNamespace("workflow"), home, workspace),
  } as unknown as CliContext;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function seedDsn(): void {
  const dev = join(home, ".workflow", "dev");
  writeFileSync(join(dev, "dsn.env"), `${CONNECTION.dsnVar}=${FAKE_DSN}\n`);
}

function inputFor(): DoctorProviderInput {
  return {
    ctx,
    hosts: [],
    hostStates: [],
    currentHost: null,
    workspaceDir: workspace,
    skipNative: false,
  };
}

/** Lo que el agregador hace con la salida del proveedor, y en ese orden. */
async function redactedFindings() {
  const output = await toolsAuthProvider.run(inputFor());
  return redactSensitiveValue(output.findings) as typeof output.findings;
}

describe("proveedor de herramientas/autenticación", () => {
  it("con la variable presente el hallazgo es sano y sigue nombrando la variable tras redactar", async () => {
    seedDsn();
    const [finding] = await redactedFindings();

    expect(finding.state).toBe("healthy");
    expect(finding.ownership).toBe("ours");
    // La mitad que se perdía: el NOMBRE de la variable sobrevive a la redacción.
    expect(finding.summary).toContain(CONNECTION.dsnVar);
    expect(finding.evidence.join(" | ")).toContain(CONNECTION.dsnVar);
    // Y la frase sigue siendo una frase: nada quedó reemplazado por `***`.
    expect(finding.summary).not.toContain("***");
    expect(finding.evidence.join(" | ")).not.toContain("***");
  });

  it("nunca refleja el valor del DSN, ni en el resumen ni en la evidencia ni en la guía", async () => {
    seedDsn();
    const findings = await redactedFindings();

    // La premisa no es vacua: el valor está de verdad donde el proveedor lo lee.
    expect(process.env[CONNECTION.dsnVar] ?? "").not.toBe(FAKE_DSN);
    const dump = JSON.stringify(findings);
    expect(dump).not.toContain("CLAVE-INVENTADA-9f3a");
    expect(dump).not.toContain(FAKE_DSN);
  });

  it("sin la variable el hallazgo advierte, nombra la variable y entrega la guía de exportarla", async () => {
    const [finding] = await redactedFindings();

    expect(finding.state).toBe("warning");
    expect(finding.summary).toContain(CONNECTION.dsnVar);
    expect(finding.summary).not.toContain("***");
    expect(finding.evidence.join(" | ")).toContain("ausente");
    // La guía viene de `buildEnvHelp`, la misma que ya imprime el alta de una
    // conexión: nombra la variable y el archivo de arranque, nunca un valor.
    expect(finding.remediation.kind).toBe("manual");
    expect(finding.remediation.action).toBeNull();
    expect(finding.remediation.guidance.join(" | ")).toContain(CONNECTION.dsnVar);

    // Y la guía tiene que seguir siendo SEGUIBLE tras la redacción. La línea que
    // `buildEnvHelp` emite —`export DB_X_DSN='<DSN>'`— llega como
    // `export DB_X_DSN=***`, y quien la copie deja literalmente `***` en su
    // archivo de arranque: el MCP falla entonces con una credencial INVÁLIDA en
    // vez de con una ausente, que es un diagnóstico peor. Ninguna línea de la
    // guía puede quedar con un `***` donde iba el valor.
    for (const line of finding.remediation.guidance) {
      expect(line).not.toContain("***");
    }
  });

  it("sin ninguna conexión registrada la categoría es no-aplicable, no una advertencia", async () => {
    rmSync(join(home, ".workflow", "dev", "mcp-connections.json"), { force: true });
    const output = await toolsAuthProvider.run(inputFor());

    expect(output.findings).toEqual([]);
    expect(output.coverage).toHaveLength(1);
    expect(output.coverage[0].state).toBe("not-applicable");
    expect(output.coverage[0].reason).not.toBeNull();
  });
});
