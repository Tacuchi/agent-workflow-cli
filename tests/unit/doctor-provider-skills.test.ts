import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// Registra la capacidad `design` en el dispatcher, igual que hace el registro de
// comandos del CLI: sin este efecto de import no hay ninguna capacidad que leer.
import "../../src/application/capability/design-handler.js";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { CAPABILITY_SKILL_MARKER } from "../../src/application/capability/wrapper.js";
import { skillsProvider } from "../../src/application/doctor/provider-skills.js";
import type { DoctorProviderInput, DoctorTargetHost } from "../../src/application/doctor/types.js";
import { PathsService } from "../../src/application/paths-service.js";
import type { CliContext } from "../../src/cli/types.js";
import type { HarnessId } from "../../src/domain/harnesses.js";
import { redactSensitiveValue } from "../../src/domain/redaction.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";

/**
 * La categoría skills del doctor, y las tres cosas que se le pueden escapar.
 *
 * 1. El `source` de una skill registrada es texto que la persona tipeó y quedó
 *    guardado verbatim. Sin credential helper, la forma habitual de una skill
 *    privada es `https://<token>@github.com/...`, y la redacción global NO la
 *    ve: `CONNECTION_URI` sólo cubre postgres/mysql/mongodb y
 *    `SECRET_ASSIGNMENT` sólo formas `clave=valor`. Ese campo sale como
 *    evidencia y como `locator` de un informe pensado para pegarse en un issue
 *    (AC-11).
 * 2. La ruta directa de una capacidad se resuelve contra el árbol de skills de
 *    UN host. Reportar sólo el veredicto de nivel superior —idéntico en todos—
 *    dejaba un wrapper ausente en el árbol de otro host sin rastro en el informe.
 * 3. Sin ningún host participante no se inventa uno: un id fuera del catálogo
 *    hace que toda capacidad se reporte «sin forma de invocación verificada»
 *    para un host que la persona nunca nombró.
 */

/** Token inventado con forma de PAT de GitHub: no puede aparecer en NINGUNA salida. */
const FAKE_TOKEN = "ghp_TOKEN-INVENTADO-9f3a1c";
const SKILL_NAME = "acme-skills";
const SKILL_REPO = "github.com/acme/skills.git";

let root: string;
let home: string;
let workspace: string;
let ctx: CliContext;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "doctor-skills-"));
  home = join(root, "home");
  workspace = join(root, "ws");
  mkdirSync(join(home, ".agents"), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  ctx = {
    fs: new NodeFileSystem(),
    env: new FakeEnv(home, workspace),
    paths: new PathsService(normalizeNamespace("workflow"), home, workspace),
  } as unknown as CliContext;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Registra una skill suelta con el `source` dado, tal cual lo guarda el registro. */
function registerSkill(source: string): void {
  writeFileSync(
    join(home, ".agents", ".skills-registry.json"),
    `${JSON.stringify({ skills: { [SKILL_NAME]: { source } } }, null, 2)}\n`,
  );
}

/** El wrapper de la capacidad `design`, propio, en el árbol de skills de un host. */
function installDesignWrapper(relativeSkillsDir: string): void {
  const dir = join(home, ...relativeSkillsDir.split("/"), "design");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    [
      "---",
      "name: design",
      "description: diseño",
      "---",
      "",
      `> ${CAPABILITY_SKILL_MARKER}.`,
      "",
    ].join("\n"),
  );
}

function hostView(id: HarnessId, current = false): DoctorTargetHost {
  return {
    host: id,
    target: id === "claude-code" ? "claude" : (id as unknown as DoctorTargetHost["target"]),
    label: id,
    status: "ready",
    current,
    runtime: { state: "available", version: null },
    workline_installed: true,
    mcp_host: null,
  };
}

function inputFor(hosts: readonly DoctorTargetHost[], currentHost: HarnessId | null = null) {
  return {
    ctx,
    hosts,
    hostStates: [],
    currentHost,
    workspaceDir: workspace,
    skipNative: false,
  } satisfies DoctorProviderInput;
}

describe("proveedor de skills — el origen de una skill registrada", () => {
  it("saca el userinfo de la URL antes de emitirlo como evidencia y como locator (AC-11)", async () => {
    const source = `https://${FAKE_TOKEN}@${SKILL_REPO}`;
    registerSkill(source);

    const output = await skillsProvider.run(inputFor([]));
    // Lo que el agregado hace con la salida del proveedor, y en ese orden: la
    // redacción global es la ÚLTIMA línea, no la primera.
    const findings = redactSensitiveValue(output.findings) as typeof output.findings;
    const finding = findings.find((f) => f.resource.name === SKILL_NAME);

    // La premisa no es vacua: la redacción global deja esta URL INTACTA, así que
    // si el proveedor no la limpia, el token sale publicado.
    expect(redactSensitiveValue(source)).toBe(source);

    expect(finding).toBeDefined();
    const dump = JSON.stringify(finding);
    expect(dump).not.toContain(FAKE_TOKEN);
    expect(dump).not.toContain("ghp_");
    // Y el repo —lo único que identifica a la skill— sobrevive: la evidencia
    // sigue diciendo de dónde vino.
    expect(finding?.resource.locator).toBe(`https://***@${SKILL_REPO}`);
    expect(finding?.evidence.join(" | ")).toContain(`origen: https://***@${SKILL_REPO}`);
  });

  it("también saca el par usuario:token, no sólo la mitad de la contraseña", async () => {
    registerSkill(`https://x-access-token:ghs_${FAKE_TOKEN}@${SKILL_REPO}`);

    const output = await skillsProvider.run(inputFor([]));
    const dump = JSON.stringify(output.findings);

    expect(dump).not.toContain(FAKE_TOKEN);
    expect(dump).not.toContain("x-access-token");
    expect(dump).toContain(`https://***@${SKILL_REPO}`);
  });

  it("un origen sin credenciales sale verbatim: la limpieza no borra lo que identifica la skill", async () => {
    const local = join(root, "fuentes", "mis-skills");
    registerSkill(local);

    const output = await skillsProvider.run(inputFor([]));
    const finding = output.findings.find((f) => f.resource.name === SKILL_NAME);

    expect(finding?.resource.locator).toBe(local);
    expect(finding?.evidence.join(" | ")).toContain(`origen: ${local}`);
  });
});

describe("proveedor de skills — la capacidad se comprueba por host", () => {
  /**
   * El defecto: `capabilityReadiness` se invocaba UNA vez y se mapeaba sólo el
   * veredicto de nivel superior, que es idéntico en todos los hosts. La mitad
   * que depende del host —`exposures.direct`, resuelta contra
   * `harness.skillsDirs[0]`— se descartaba, así que un wrapper instalado en
   * `~/.claude/skills` y ausente en `~/.agents/skills` (el árbol de codex)
   * producía la misma fila y ningún rastro del hueco.
   */
  it("emite un hallazgo por host y distingue el host donde falta el wrapper", async () => {
    installDesignWrapper(".claude/skills");

    const output = await skillsProvider.run(
      inputFor([hostView("claude-code", true), hostView("codex")]),
    );
    const capabilities = output.findings.filter((f) => f.resource.kind === "capability");

    expect(capabilities.map((f) => f.id)).toEqual([
      "claude-code/skills/capability:design",
      "codex/skills/capability:design",
    ]);
    const [claude, codex] = capabilities;

    // El host con el wrapper propio no arrastra el hueco del otro.
    expect(claude.host).toBe("claude-code");
    expect(claude.state).toBe("healthy");
    expect(claude.remediation.kind).toBe("none");
    expect(claude.summary).toContain("claude-code");
    expect(claude.evidence.join(" | ")).toContain("ruta directa en 'claude-code': ready");
    expect(claude.evidence.join(" | ")).not.toContain(".agents/skills");

    // Y el que no lo tiene lo dice, nombrando SU árbol y con la acción que lo
    // arregla — no una fila `checked` sin ámbito.
    expect(codex.host).toBe("codex");
    expect(codex.state).toBe("warning");
    expect(codex.evidence.join(" | ")).toContain("ruta directa en 'codex'");
    expect(codex.evidence.join(" | ")).toContain(join(home, ".agents", "skills"));
    expect(codex.remediation.kind).toBe("manual");
    expect(codex.remediation.guidance.join(" | ")).toContain("aw self install-skill");
  });

  /**
   * AC-02: la cobertura se declara por host. La fila `workspace` se queda —y
   * está justificada en el módulo: el registro y las réplicas viven en el HOME
   * de la persona, no en un host— pero ya no es la ÚNICA: cada host
   * participante declara que su ruta directa se miró.
   */
  it("declara la cobertura del workspace y además una por host participante (AC-02)", async () => {
    installDesignWrapper(".claude/skills");

    const output = await skillsProvider.run(
      inputFor([hostView("claude-code", true), hostView("codex")]),
    );

    expect(
      output.coverage.map((entry) => `${entry.category}/${entry.host}/${entry.state}`),
    ).toEqual(["skills/workspace/checked", "skills/claude-code/checked", "skills/codex/checked"]);
    for (const entry of output.coverage) expect(entry.reason).toBeNull();
  });

  /**
   * `aw doctor --only kimi` en una máquina sin kimi deja la selección vacía. El
   * literal de reserva `"claude"` no es un id del catálogo (es `claude-code`),
   * así que `capabilityReadiness` no podía resolverlo y toda capacidad salía
   * «no hay una forma de invocación verificada para el host 'claude'»: un host
   * que la persona nunca escribió y que no existe.
   */
  it("sin ningún host participante no inventa un host: no hay hallazgos de capacidad", async () => {
    registerSkill(`https://${FAKE_TOKEN}@${SKILL_REPO}`);

    const output = await skillsProvider.run(inputFor([], null));

    expect(output.findings.filter((f) => f.resource.kind === "capability")).toEqual([]);
    // El registro SÍ se comprobó —eso no depende de ningún host— y la cobertura
    // no declara comprobado ningún host.
    expect(output.findings.map((f) => f.resource.name)).toEqual([SKILL_NAME]);
    expect(output.coverage.map((entry) => entry.host)).toEqual(["workspace"]);
    // Y en ninguna parte aparece un host fuera del catálogo.
    expect(JSON.stringify(output)).not.toContain("host 'claude'");
  });
});
