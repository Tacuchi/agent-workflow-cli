import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PathsService } from "../../src/application/paths-service.js";
import { SKILL_DIR_NAME, TARGET_ROOTS } from "../../src/application/self/install-skill.js";
import { WORKFLOW_CONTENT } from "../../src/cli/tui/data/workflow-content.js";
import { HOSTS, SHARED_DESTINATIONS } from "../../src/cli/tui/hosts.js";
import { WorkflowTab } from "../../src/cli/tui/tabs/workflow-tab.js";
import type { CliContext } from "../../src/cli/types.js";
import { FLOW_DECISIONS } from "../../src/domain/flow/authority.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import type { ResolvedRuntime } from "../../src/runtime/types.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { FakeProcess } from "../helpers/fake-process.js";
// [Workline] mounts HostAdminSection (fs.exists over ~/.<host>/skills/w), so
// the harness needs a real sandbox home; NoScanFs keeps everything real but
// stubs list()→[] — same pattern as the skills-tab test.
import { NoScanFs as RealFs } from "../helpers/real-fs.js";

function buildCtx(home: string): CliContext {
  const ns = normalizeNamespace("agent-workflow");
  const runtime: ResolvedRuntime = {
    packageName: "@tacuchi/agent-workflow-cli",
    binName: "agent-workflow",
    source: "default",
  };
  return {
    fs: new RealFs(),
    env: new FakeEnv(home),
    process: new FakeProcess({ run: () => ({ code: 0, stdout: "", stderr: "" }) }),
    git: {} as never,
    namespace: { namespace: ns, source: "default" },
    runtime,
    paths: new PathsService(ns, home, home),
  };
}

describe("WorkflowTab ([Workline] = admin + informativo mínimo)", () => {
  let workdir: string;
  let home: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "aw-workflow-tab-test-"));
    home = join(workdir, "home");
    await mkdir(home, { recursive: true });
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  async function renderFlat(disabledHosts?: readonly string[]): Promise<string> {
    const { lastFrame, unmount } = render(
      <WorkflowTab ctx={buildCtx(home)} isActive {...(disabledHosts ? { disabledHosts } : {})} />,
    );
    await new Promise((r) => setTimeout(r, 80));
    const frame = (lastFrame() ?? "").replace(/\s+/g, " ");
    unmount();
    return frame;
  }

  it("header: título Workline + counts derivados de los data modules (.length)", async () => {
    const frame = await renderFlat();
    expect(frame).toContain("Workline");
    // Los totales son del BUNDLE, no una promesa universal: la cabecera lo dice
    // y la superficie real de cada host va en su fila.
    expect(frame).toContain(`bundle: ${WORKFLOW_CONTENT.slashCommands.length} commands`);
    expect(frame).toContain(`${WORKFLOW_CONTENT.hooks.length} hooks`);
    expect(frame).toContain("per-host surface shown on each row");
  });

  it("informativo mínimo: overview 1 línea + strip de flows; sin FamilyCards ni PhaseCards", async () => {
    const frame = await renderFlat();
    expect(frame).toContain("Flows:");
    expect(frame).toContain("SPEC · PLAN · QUICK");
    // Sections retired by the redesign (U2) must not render.
    expect(frame).not.toContain("Command families");
    expect(frame).not.toContain("Workspace init");
  });

  // El motor de dirección tiene su propia fila, y su cifra sale del registro de
  // autoridad — nunca de un número escrito a mano, que se quedaría viejo en el
  // primer tramo migrado y haría que la pestaña reporte mal la migración.
  it("fila del motor: `aw flow` con su propiedad derivada del registro de autoridad", async () => {
    const frame = await renderFlat();
    expect(frame).toContain("Engine:");
    expect(frame).toContain(WORKFLOW_CONTENT.engine.command);
    const owned = FLOW_DECISIONS.filter((d) => d.ownership === "cli-owned").length;
    expect(frame).toContain(`${owned}/${FLOW_DECISIONS.length} CLI-owned`);
  });

  it("administración por host montada: sección Hosts con TODOS los targets del registro", async () => {
    const frame = await renderFlat();
    expect(frame).toContain("HOSTS");
    // Derived from HOSTS (not a hardcoded list): if the registry gains or loses
    // a host, this assert follows — lesson from the clean-legacy v14.5.1 bug.
    for (const host of HOSTS) {
      expect(frame).toContain(host.name);
    }
    expect(frame).toContain("skills/w/");
  });

  // Un host apagado en [Config] es un opt-out de targeting, y hasta ahora sólo lo
  // respetaba el tile de status: acá se listaba igual y se podía instalar en él.
  describe("hosts apagados en [Config]", () => {
    const OFF = HOSTS[0];
    const ON = HOSTS[1];

    it("el host apagado desaparece de la lista y los activos siguen", async () => {
      if (!OFF || !ON) throw new Error("el catálogo debe tener al menos dos hosts");
      const frame = await renderFlat([OFF.id]);
      expect(frame).not.toContain(OFF.name);
      expect(frame).toContain(ON.name);
    });

    it("la cabecera dice cuántos quedaron afuera, así el conteo no miente", async () => {
      if (!OFF) throw new Error("el catálogo debe tener al menos un host");
      const frame = await renderFlat([OFF.id]);
      expect(frame).toContain("1 off in [Config]");
      // El contador de la sección cuenta los visibles, no el catálogo entero.
      expect(frame).toContain(`HOSTS ${HOSTS.length - 1}`);
    });

    it("si el host apagado TIENE instalación, la pantalla lo avisa en vez de esconderla", async () => {
      if (!OFF) throw new Error("el catálogo debe tener al menos un host");
      await mkdir(join(home, ...TARGET_ROOTS[OFF.id], SKILL_DIR_NAME), { recursive: true });
      const frame = await renderFlat([OFF.id]);
      expect(frame).not.toContain(`◆ ${OFF.name}`);
      expect(frame).toContain(`${OFF.name} is off in [Config] and still installed`);
    });

    it("sin hosts apagados no aparece ni el aviso ni la nota de la cabecera", async () => {
      const frame = await renderFlat();
      expect(frame).not.toContain("off in [Config]");
    });
  });

  // The hooks-armed section mounts here now, so its ~/.claude/settings.json
  // detection is pinned here.
  // Un `hooks{}` no vacío ya NO alcanza: el usuario puede tener hooks propios.
  // "armed" significa que están LOS NUESTROS, y eso se prueba por el comando.
  it("muestra 'hooks armed' cuando settings.json trae NUESTROS hooks", async () => {
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(
      join(home, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              matcher: "startup|resume|clear",
              hooks: [{ type: "command", command: "agent-workflow self namespace --pin workflow" }],
            },
          ],
        },
      }),
      "utf8",
    );
    const frame = await renderFlat();
    expect(frame).toContain("hooks armed");
  });

  it("NO dice 'hooks armed' cuando los únicos hooks son del usuario", async () => {
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(
      join(home, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "echo hola" }] }],
        },
      }),
      "utf8",
    );
    const frame = await renderFlat();
    expect(frame).not.toContain("hooks armed");
  });

  it("no crashea con settings.json inválido y no muestra hooks armed", async () => {
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(join(home, ".claude", "settings.json"), "{not valid", "utf8");
    const frame = await renderFlat();
    expect(frame).toContain("Claude Code");
    expect(frame).not.toContain("hooks armed");
  });

  // La lista de targets se acota a la altura del terminal (useListWindow): con
  // un viewport chico la ventana sigue al cursor y la última fila se alcanza.
  it("ventana: viewport chico acota el frame y el cursor alcanza la última fila", async () => {
    const { lastFrame, stdin, stdout } = render(<WorkflowTab ctx={buildCtx(home)} isActive />);
    await new Promise((r) => setTimeout(r, 80));
    const fullLines = (lastFrame() ?? "").split("\n").length;
    // Non-TTY (rows=0) renders every row; shrink the viewport to force a window.
    const fakeStdout = stdout as unknown as { rows?: number; emit(event: string): boolean };
    fakeStdout.rows = 32; // 32 - HOSTS_LIST_RESERVED_ROWS(28) → 4 rows visibles
    fakeStdout.emit("resize");
    await new Promise((r) => setTimeout(r, 40));
    const total = HOSTS.length + SHARED_DESTINATIONS.length;
    let frame = lastFrame() ?? "";
    // Overflow indicator in the HOSTS head: window range with en-dash.
    expect(frame).toContain(`1–4 de ${total}`);
    expect(frame.split("\n").length).toBeLessThan(fullLines);
    // Walk to the last row: the window follows and the row renders.
    for (let i = 0; i < total - 1; i++) {
      stdin.write("\x1B[B");
      await new Promise((r) => setTimeout(r, 20));
    }
    frame = lastFrame() ?? "";
    expect(frame).toContain(`${total - 3}–${total} de ${total}`);
    expect(frame).toContain(SHARED_DESTINATIONS[SHARED_DESTINATIONS.length - 1]?.name ?? "");
    // The first host scrolled out of the window. Asserted on its ROW: the
    // empty-state bar names the first LISTED host, so the bare name still
    // appears at the bottom and would make this pass for the wrong reason.
    expect(frame).not.toContain(`◆ ${HOSTS[0]?.name ?? ""}`);
  });
});
