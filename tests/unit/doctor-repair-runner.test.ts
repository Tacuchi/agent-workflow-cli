import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliContext } from "../../src/cli/types.js";
import { DOCTOR_OPERATIONS } from "../../src/domain/doctor/operations.js";

/**
 * El cableado entre una operación y la función que de verdad escribe.
 *
 * Este archivo existe porque su ausencia era el agujero más caro del lote. El
 * catálogo declara un `delegates` por operación, pero eso es una CADENA: nadie
 * en producción la lee. Lo que decide qué se ejecuta es el `switch (action.op)`
 * de `repair-runner.ts`, y una auditoría por mutación demostró que estaba
 * completamente descubierto: reescribir `case "skills.reinstall"` para llamar a
 * `selfUninstall` —que BORRA— dejaba las 4585 pruebas del repositorio en verde.
 *
 * El daño de ese defecto no se parece a ningún otro de este plan. Todo lo demás
 * falla del lado seguro: un hallazgo que no se propone, una acción que no se
 * ofrece, un lote que no se sella. Un `case` cruzado falla del lado contrario y
 * con la autorización YA DADA: la persona leyó «reinstalar las réplicas de la
 * skill», aprobó su digest, y el CLI corrió el desinstalador.
 *
 * Los delegados se doblan con `vi.mock` en vez de refactorizar el switch a una
 * tabla inyectable: el objetivo es fijar el cableado que EXISTE, y un refactor
 * hecho para poder probarlo cambiaría justamente la cosa bajo prueba.
 */

const calls: string[] = [];
/** Los argumentos con los que se llamó a cada delegado, en orden. */
const invocations: Array<{ name: string; args: unknown[] }> = [];
/** Lo que un delegado devuelve en ESTA prueba. Vacío = su resultado exitoso. */
const overrides = new Map<string, unknown>();

/** Cada doble registra su nombre Y sus argumentos, y devuelve algo plausible. */
function spy(name: string, result: unknown = { ok: true, exitCode: 0 }) {
  return (...args: unknown[]) => {
    calls.push(name);
    invocations.push({ name, args });
    return overrides.has(name) ? overrides.get(name) : result;
  };
}

vi.mock("../../src/application/self/install-skill.js", () => ({
  selfInstallSkill: spy("selfInstallSkill"),
}));
vi.mock("../../src/application/self/uninstall.js", () => ({
  selfUninstall: spy("selfUninstall"),
}));
vi.mock("../../src/application/self/install-hooks.js", () => ({
  selfInstallHooks: spy("selfInstallHooks"),
}));
vi.mock("../../src/application/self/clean-legacy.js", () => ({
  selfCleanLegacy: spy("selfCleanLegacy"),
}));
vi.mock("../../src/application/self/skills-manager.js", () => ({
  reinstallSkill: spy("reinstallSkill"),
}));
vi.mock("../../src/application/mcp-setup-service.js", () => ({
  runMcpSetup: spy("runMcpSetup", { applied: [{}], conflicts: [], errors: [] }),
}));
vi.mock("../../src/application/mcp-remove-service.js", () => ({
  runMcpRemove: spy("runMcpRemove", { applied: [{}], conflicts: [], errors: [] }),
}));
vi.mock("../../src/application/mcp-migration-service.js", () => ({
  runMcpMigration: spy("runMcpMigration", { items: [{ action: "install" }] }),
}));
vi.mock("../../src/application/multiroot-service.js", () => ({
  runMultiroot: spy("runMultiroot", {}),
}));
vi.mock("../../src/application/mcp-connections-service.js", () => ({
  readMcpConnections: () => [{ name: "cert", dsnVar: "DB_CERT_DSN", provider: "postgres" }],
}));

const { runDoctorRepair } = await import("../../src/application/doctor/repair-runner.js");

const ctx = {
  fs: {},
  env: { homeDir: () => "/home/tester" },
  paths: { workspaceDir: () => "/ws" },
} as unknown as CliContext;

function actionFor(op: string, args: Record<string, string> = {}) {
  return {
    finding_id: `claude-code/mcps/${op}`,
    host: "claude-code",
    resource: "recurso",
    op,
    args,
    effects: [],
    depends_on: [],
    expected: "healthy",
    verb: "—",
    summary: "—",
  };
}

/**
 * El cableado esperado, ESCRITO A MANO.
 *
 * A propósito no se deriva de `DOCTOR_OPERATIONS[].delegates`: si el esperado
 * saliera del catálogo, un `delegates` equivocado y un `case` equivocado se
 * moverían juntos y la prueba seguiría verde — que es exactamente el defecto que
 * este archivo persigue. Acá el catálogo se usa sólo para comprobar que la tabla
 * no se quedó corta.
 */
const WIRING: ReadonlyArray<{ op: string; delegate: string; args?: Record<string, string> }> = [
  { op: "self.install-skill", delegate: "selfInstallSkill", args: { target: "user" } },
  { op: "self.uninstall", delegate: "selfUninstall", args: { target: "user" } },
  { op: "self.install-hooks", delegate: "selfInstallHooks", args: { target: "claude" } },
  { op: "self.clean-legacy", delegate: "selfCleanLegacy", args: { target: "claude" } },
  { op: "skills.reinstall", delegate: "reinstallSkill", args: { name: "w:doctor" } },
  {
    op: "mcp.setup",
    delegate: "runMcpSetup",
    args: { host: "claude", instance: "cert", scope: "workspace" },
  },
  {
    op: "mcp.remove",
    delegate: "runMcpRemove",
    args: { host: "claude", instance: "cert", scope: "workspace" },
  },
  {
    op: "mcp.migrate",
    delegate: "runMcpMigration",
    args: { host: "claude", instance: "cert", scope: "workspace" },
  },
  { op: "multiroot.attach", delegate: "runMultiroot", args: { scope: "workspace" } },
  { op: "multiroot.detach", delegate: "runMultiroot", args: { scope: "workspace" } },
];

describe("el cableado entre una operación y la función que escribe", () => {
  beforeEach(() => {
    calls.length = 0;
    invocations.length = 0;
    overrides.clear();
  });

  for (const { op, delegate, args } of WIRING) {
    it(`'${op}' llama a ${delegate} y a NADIE más`, async () => {
      const outcome = await runDoctorRepair(actionFor(op, args), ctx);

      // Exactamente un delegado, y es el que corresponde. `toEqual` sobre la
      // lista entera —y no un `toContain`— porque el daño de este defecto es
      // llamar a OTRA función además de, o en vez de, la correcta.
      expect(calls).toEqual([delegate]);
      expect(outcome.status).toBe("applied");
    });
  }

  it("la tabla cubre TODAS las operaciones del catálogo, sin faltar ni sobrar", () => {
    // Sin esto, agregar una operación al catálogo dejaría su cableado sin probar
    // y este archivo seguiría verde: el hueco volvería a abrirse en silencio.
    const declared = DOCTOR_OPERATIONS.map((spec) => spec.op).sort();
    const wired = WIRING.map((row) => row.op).sort();
    expect(wired).toEqual(declared);
  });

  it("una operación que el catálogo no declara no ejecuta nada y se reporta fallida", async () => {
    // El fail-closed del adaptador: una `op` sin `case` no puede volver
    // `applied` optimista, porque el recurso quedó como estaba y decir que se
    // aplicó lo declararía reparado sin que nadie lo tocara.
    const outcome = await runDoctorRepair(actionFor("mcp.teleport"), ctx);

    expect(calls).toEqual([]);
    expect(outcome.status).toBe("failed");
    expect(outcome.detail).toContain("mcp.teleport");
  });

  it("un delegado que devuelve un fallo se reporta fallido, no aplicado", async () => {
    // El resultado se LEE del delegado, nunca se asume por haberlo llamado.
    overrides.set("selfInstallSkill", {
      ok: false,
      error: { code: "SKILL_TARGET_UNKNOWN", message: "destino desconocido" },
      exitCode: 1,
    });

    const outcome = await runDoctorRepair(actionFor("self.install-skill", { target: "x" }), ctx);

    expect(calls).toEqual(["selfInstallSkill"]);
    expect(outcome.status).toBe("failed");
    // El código viaja: sin él la persona ve «falló» y nada más.
    expect(outcome.detail).toContain("SKILL_TARGET_UNKNOWN");
  });

  it("un delegado que se declara BLOQUEADO no se confunde con uno que falló", async () => {
    // `install-hooks` devuelve un estado bloqueado cuando una entrada inválida
    // de la persona desarmaría su sección: no es un fallo del doctor, es una
    // negativa deliberada de la operación, y el lote la respeta como tal en vez
    // de reintentarla o de contarla como error propio.
    overrides.set("selfInstallHooks", {
      ok: false,
      error: { code: "HOOKS_BLOCKED", message: "una entrada inválida bloquea la sección" },
      exitCode: 1,
    });

    const outcome = await runDoctorRepair(
      actionFor("self.install-hooks", { target: "claude" }),
      ctx,
    );

    expect(outcome.status).toBe("blocked");
    expect(outcome.status).not.toBe("failed");
  });

  it("una entrada MCP ajena homónima bloquea en vez de pisarse", async () => {
    // El servicio de MCP no lanza: preserva la entrada ajena y la devuelve en
    // `conflicts`. Eso NO es un fallo del doctor —la protección funcionó— pero
    // el recurso no quedó reparado, así que la acción no puede decir «aplicada».
    overrides.set("runMcpSetup", { applied: [], conflicts: [{}], errors: [] });

    const outcome = await runDoctorRepair(
      actionFor("mcp.setup", { host: "claude", instance: "cert", scope: "workspace" }),
      ctx,
    );

    expect(outcome.status).toBe("blocked");
    expect(outcome.detail).toContain("ajena");
  });

  it("el scope global viaja con su autorización explícita, y el de workspace no la lleva", async () => {
    // `runMcpSetup` se NIEGA a escribir una configuración global sin su
    // autorización explícita, y con razón: tocarla afecta todos los proyectos de
    // la máquina. El adaptador la pasa porque la persona ya aprobó el digest de
    // ESTE lote — y lo que no puede pasar es que el scope se pierda en el camino
    // y una escritura global se cuele como de workspace, o al revés, que una de
    // workspace lleve una autorización que nadie dio para ella.
    await runDoctorRepair(
      actionFor("mcp.setup", { host: "claude", instance: "cert", scope: "global" }),
      ctx,
    );
    const globalCall = invocations.find((call) => call.name === "runMcpSetup");
    expect(globalCall?.args[1]).toMatchObject({
      scope: "global",
      globalApproval: "explicit-self-action",
      hosts: ["claude"],
    });

    invocations.length = 0;
    await runDoctorRepair(
      actionFor("mcp.setup", { host: "claude", instance: "cert", scope: "workspace" }),
      ctx,
    );
    const workspaceCall = invocations.find((call) => call.name === "runMcpSetup");
    expect(workspaceCall?.args[1]).toMatchObject({ scope: "workspace", workspace: "/ws" });
    expect(workspaceCall?.args[1]).not.toHaveProperty("globalApproval");
  });

  it("la conexión que la operación recibe es la que su instancia nombra, no cualquiera", async () => {
    // `mcpInput` filtra el registro por el nombre de la instancia. Sin ese
    // filtro, reparar `cert` pasaría TODAS las conexiones registradas y el
    // servicio escribiría entradas que nadie aprobó en la vista previa.
    await runDoctorRepair(
      actionFor("mcp.setup", { host: "claude", instance: "cert", scope: "workspace" }),
      ctx,
    );
    const call = invocations.find((entry) => entry.name === "runMcpSetup");
    expect(call?.args[1]).toMatchObject({ connections: [{ name: "cert" }] });

    invocations.length = 0;
    await runDoctorRepair(
      actionFor("mcp.setup", { host: "claude", instance: "no-registrada", scope: "workspace" }),
      ctx,
    );
    const missing = invocations.find((entry) => entry.name === "runMcpSetup");
    expect(missing?.args[1]).toMatchObject({ connections: [] });
  });

  it("el nombre de la skill llega tal cual: reinstalar otra no es reinstalar la del hallazgo", async () => {
    await runDoctorRepair(actionFor("skills.reinstall", { name: "w:doctor" }), ctx);
    const call = invocations.find((entry) => entry.name === "reinstallSkill");
    expect(call?.args[1]).toBe("w:doctor");
  });
});
