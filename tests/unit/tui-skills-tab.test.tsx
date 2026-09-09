import type { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { applySkillChange } from "../../src/application/self/skills-apply.js";
import {
  type SkillChangeRequest,
  prepareSkillChange,
} from "../../src/application/self/skills-change.js";
import { canonicalSkillsRoot, listSkills } from "../../src/application/self/skills-manager.js";
import { skillsRegistryPath } from "../../src/application/self/skills-registry.js";
import { RECOMMENDED_SKILLS } from "../../src/cli/tui/data/recommended-skills.js";
import { SkillsTab } from "../../src/cli/tui/tabs/skills-tab.js";
import type { CliContext } from "../../src/cli/types.js";
import { FakeEnv } from "../helpers/fake-env.js";

const ENTER = "\r";
const DOWN = "\x1B[B";
const UP = "\x1B[A";
const ESC = "\x1B";
// The list opens projected to the recommended seed (SPEC 019): a skill outside
// it is only reachable after this toggle.
const TOGGLE = "t";
const tick = (ms = 120) => new Promise((r) => setTimeout(r, ms));

// Cada línea del frame lleva una fila de la lista Y un trozo del panel, así
// que una ruta que el panel parte no se puede recomponer desde el frame: lo
// que se afirma es su comienzo, que ya distingue la fuente instalada de la del
// catálogo. Quitar espacios y bordes pega la etiqueta con su valor.
const dense = (frame: string): string => frame.replace(/[\s│]+/g, "");
/** Prefijo de una ruta temporal que entra en el primer trozo del panel. */
const pathHead = (path: string): string => path.slice(0, 12);

// The tab uses the real skills-manager against a sandbox home (real adapter):
// listSkills/register/install operate on a tmpdir, never the dev's HOME.
function buildCtx(home: string): CliContext {
  return { fs: new NodeFileSystem(), env: new FakeEnv(home) } as unknown as CliContext;
}

/** Test setup through the ONE door: prepare, then apply the sealed proposal.
 *  The tab's own journey is exercised by the cases below; this is only how a
 *  previous installation gets there. */
async function applyChange(ctx: CliContext, request: SkillChangeRequest): Promise<void> {
  const prepared = await prepareSkillChange(ctx, request);
  if (prepared.status !== "prepared") throw new Error(`preparación: ${prepared.status}`);
  try {
    const applied = await applySkillChange(ctx, prepared.proposal, prepared.proposal.digest);
    if (applied.status !== "applied") throw new Error(`aplicación: ${applied.refusal.code}`);
  } finally {
    await prepared.release();
  }
}

async function makeSkillDir(parent: string, name: string): Promise<string> {
  const dir = join(parent, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: test skill ${name}\n---\nbody\n`,
    "utf8",
  );
  return dir;
}

describe("SkillsTab (TUI) — administrador de sueltas (F4)", () => {
  let workdir: string;
  let home: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "aw-skills-tab-test-"));
    home = join(workdir, "home");
    await mkdir(home, { recursive: true });
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it("lista las recomendadas de la semilla con counts derivados (0/0/N)", async () => {
    const { lastFrame, unmount } = render(<SkillsTab ctx={buildCtx(home)} isActive={true} />);
    await tick();
    const frame = (lastFrame() ?? "").replace(/\s+/g, " ");
    expect(frame).toContain(
      `0 installed · 0 registered · ${RECOMMENDED_SKILLS.length} recommended`,
    );
    expect(frame).toContain("pdf");
    expect(frame).toContain("anthropics/skills");
    expect(frame).toContain("diagnosing-bugs");
    unmount();
  });

  it("una registrada aparece antes que las recomendadas y con su badge", async () => {
    const ctx = buildCtx(home);
    const src = await makeSkillDir(workdir, "mi-skill");
    await applyChange(ctx, { operation: "register", source: src });

    const { lastFrame, stdin, unmount } = render(<SkillsTab ctx={ctx} isActive={true} />);
    await tick();
    stdin.write(TOGGLE); // "mi-skill" no está en la semilla: se ve en modo todas
    await tick();
    const frame = (lastFrame() ?? "").replace(/\s+/g, " ");
    expect(frame).toContain(
      `0 installed · 1 registered · ${RECOMMENDED_SKILLS.length} recommended`,
    );
    // Order: the registered one first (cursor starts there).
    expect(frame.indexOf("mi-skill")).toBeLessThan(frame.indexOf("codebase-design"));
    unmount();
  });

  it("una canónica fuera del registro se lista como unmanaged (fuente del lock) y su detail no ofrece acciones", async () => {
    const ctx = buildCtx(home);
    await makeSkillDir(join(home, ".agents", "skills"), "ajena");
    await writeFile(
      join(home, ".agents", ".skill-lock.json"),
      JSON.stringify({ skills: { ajena: { source: "softaworks/agent-toolkit" } } }),
      "utf8",
    );

    const { lastFrame, stdin, unmount } = render(<SkillsTab ctx={ctx} isActive={true} />);
    await tick();
    stdin.write(TOGGLE); // "ajena" está fuera de la semilla
    await tick();
    const frame = (lastFrame() ?? "").replace(/\s+/g, " ");
    expect(frame).toContain(
      `0 installed · 1 unmanaged · 0 registered · ${RECOMMENDED_SKILLS.length} recommended`,
    );
    expect(frame).toContain("ajena");
    expect(frame).toContain("softaworks/agent-toolkit");

    // El toggle conserva la skill seleccionada (la primera de la semilla), que
    // en la lista completa queda justo debajo de la única fila unmanaged.
    stdin.write(UP);
    await tick();
    stdin.write(ENTER); // first row = the unmanaged one (ranks above registered/recommended)
    await tick();
    const detail = (lastFrame() ?? "").replace(/\s+/g, " ");
    expect(detail).toContain("outside the registry");
    // Informational only: no engine actions on foreign dirs.
    expect(detail).not.toContain("Reinstall");
    expect(detail).not.toContain("Uninstall");
    expect(detail).not.toContain("Remove");
    unmount();
  });

  it("⏎ sobre una recomendada abre el detail con Install y su descripción", async () => {
    const { lastFrame, stdin, unmount } = render(
      <SkillsTab ctx={buildCtx(home)} isActive={true} />,
    );
    await tick();
    stdin.write(ENTER); // first row (recommended, alphabetical order)
    await tick();
    const frame = (lastFrame() ?? "").replace(/\s+/g, " ");
    expect(frame).toContain("Install");
    expect(frame).toContain("Install");
    unmount();
  });

  it("wizard [a]: pide la fuente y esc cancela de vuelta a la lista", async () => {
    const { lastFrame, stdin, unmount } = render(
      <SkillsTab ctx={buildCtx(home)} isActive={true} />,
    );
    await tick();
    stdin.write("a");
    await tick();
    expect(lastFrame() ?? "").toContain("owner/repo · git URL · absolute path");
    stdin.write(""); // esc
    await tick();
    expect(lastFrame() ?? "").not.toContain("owner/repo · git URL · absolute path");
    unmount();
  });

  it("una instalada de fuente LOCAL ofrece Repair/Uninstall/Remove pero NO Update", async () => {
    const ctx = buildCtx(home);
    const src = await makeSkillDir(workdir, "local-skill");
    await applyChange(ctx, { operation: "install", source: src });

    const { lastFrame, stdin, unmount } = render(<SkillsTab ctx={ctx} isActive={true} />);
    await tick();
    stdin.write(TOGGLE); // "local-skill" está fuera de la semilla
    await tick();
    stdin.write(UP); // la selección conservada baja una fila: la instalada encabeza
    await tick();
    stdin.write(ENTER); // first row = the installed one (manager order)
    await tick();
    const frame = (lastFrame() ?? "").replace(/\s+/g, " ");
    expect(frame).toContain("Repair");
    expect(frame).toContain("Uninstall");
    expect(frame).toContain("Remove");
    // Update is git-sources-only (canonical classifier, not startsWith("/")).
    expect(frame).not.toContain("Update");
    unmount();
  });

  it("Uninstall confirma, muestra la vista previa completa y sólo aplica al elegir Apply", async () => {
    const ctx = buildCtx(home);
    const src = await makeSkillDir(workdir, "local-skill");
    await applyChange(ctx, { operation: "install", source: src });

    const { lastFrame, stdin, unmount } = render(<SkillsTab ctx={ctx} isActive={true} />);
    await tick();
    stdin.write(TOGGLE); // "local-skill" está fuera de la semilla
    await tick();
    stdin.write(UP); // la selección conservada baja una fila: la instalada encabeza
    await tick();
    stdin.write(ENTER); // detail (actions: Repair, Uninstall, Remove)
    await tick();
    stdin.write(DOWN); // → Uninstall
    await tick(40);
    stdin.write(ENTER);
    await tick();
    expect((lastFrame() ?? "").replace(/\s+/g, " ")).toContain("Uninstall local-skill?");

    stdin.write("y");
    await tick(400);
    const preview = (lastFrame() ?? "").replace(/\s+/g, " ");
    // La vista previa enumera el conjunto y TODAS las ubicaciones, con el foco
    // en Back: aceptar la confirmación no aplicó nada todavía.
    expect(preview).toContain("PROPOSED CHANGES · UNINSTALL");
    expect(preview).toContain("− local-skill");
    expect(preview).toContain("agents");
    expect(preview).toContain("claude");
    expect(preview).toContain("gemini");
    expect(preview).toContain("Back");
    expect(preview).toContain("Apply");
    expect(existsSync(join(canonicalSkillsRoot(home), "local-skill"))).toBe(true);

    stdin.write(DOWN); // → Apply (el foco arranca en Back)
    await tick(40);
    stdin.write(ENTER);
    await tick(600);
    const result = (lastFrame() ?? "").replace(/\s+/g, " ");
    // El resultado es una vista por destino, con su comprobación aparte.
    expect(result).toContain("RESULT · UNINSTALL");
    expect(result).toContain("applied");
    expect(result).toContain("verified");
    expect(existsSync(join(canonicalSkillsRoot(home), "local-skill"))).toBe(false);

    stdin.write(ENTER); // vuelve a la lista ya refrescada
    await tick(300);
    expect((lastFrame() ?? "").replace(/\s+/g, " ")).toContain(
      `0 installed · 1 registered · ${RECOMMENDED_SKILLS.length} recommended`,
    );
    unmount();
  });

  it("Back en la vista previa cancela sin tocar nada", async () => {
    const ctx = buildCtx(home);
    const src = await makeSkillDir(workdir, "local-skill");
    await applyChange(ctx, { operation: "install", source: src });

    const { lastFrame, stdin, unmount } = render(<SkillsTab ctx={ctx} isActive={true} />);
    await tick();
    stdin.write(TOGGLE);
    await tick();
    stdin.write(UP);
    await tick();
    stdin.write(ENTER); // detail
    await tick();
    stdin.write(DOWN); // → Uninstall
    await tick(40);
    stdin.write(ENTER);
    await tick();
    stdin.write("y");
    await tick(400);
    expect((lastFrame() ?? "").replace(/\s+/g, " ")).toContain("PROPOSED CHANGES");

    stdin.write(ENTER); // el foco está en Back
    await tick(300);
    expect(existsSync(join(canonicalSkillsRoot(home), "local-skill"))).toBe(true);
    expect((lastFrame() ?? "").replace(/\s+/g, " ")).not.toContain("PROPOSED CHANGES");
    unmount();
  });

  it("Remove de una recomendada registrada la devuelve a recommended (AC6, a nivel tab)", async () => {
    const ctx = buildCtx(home);
    // Local source whose skill dir is named like one of the seed's recommended skills.
    const src = await makeSkillDir(workdir, "pdf");
    await applyChange(ctx, { operation: "register", source: src });

    const { lastFrame, stdin, unmount } = render(<SkillsTab ctx={ctx} isActive={true} />);
    await tick();
    stdin.write(ENTER); // detail of 'pdf' (registered → Install, Remove)
    await tick();
    stdin.write(DOWN); // → Remove
    await tick(40);
    stdin.write(ENTER);
    await tick();
    expect((lastFrame() ?? "").replace(/\s+/g, " ")).toContain("Remove pdf?");

    stdin.write("y");
    await tick(400);
    expect((lastFrame() ?? "").replace(/\s+/g, " ")).toContain("PROPOSED CHANGES · REMOVE");
    stdin.write(DOWN);
    await tick(40);
    stdin.write(ENTER); // Apply
    await tick(600);
    stdin.write(ENTER); // back to the list
    await tick(300);
    const after = (lastFrame() ?? "").replace(/\s+/g, " ");
    // It never disappears: it returns to the catalog's recommended state.
    expect(after).toContain(
      `0 installed · 0 registered · ${RECOMMENDED_SKILLS.length} recommended`,
    );
    expect(after).toContain("pdf");
    unmount();
  });

  it("alta [a]: fuente → vista previa con su advertencia y sus efectos → Apply", async () => {
    const ctx = buildCtx(home);
    const src = await makeSkillDir(workdir, "nueva-skill");
    const { lastFrame, stdin, unmount } = render(<SkillsTab ctx={ctx} isActive={true} />);
    await tick();
    stdin.write("a");
    await tick();
    stdin.write(src); // absolute path of the source
    await tick();
    stdin.write(ENTER); // one candidate → straight to the preview
    await tick(600);
    const preview = (lastFrame() ?? "").replace(/\s+/g, " ");
    expect(preview).toContain("PROPOSED CHANGES · INSTALL");
    expect(preview).toContain("+ nueva-skill");
    // La advertencia de terceros vive donde se decide, y viaja sellada.
    expect(preview).toContain("con los permisos de tu host");
    expect(preview).toContain("EFFECTS");
    // Nada instalado mientras la vista previa está abierta.
    expect(existsSync(canonicalSkillsRoot(home))).toBe(false);

    stdin.write(DOWN);
    await tick(40);
    stdin.write(ENTER); // Apply
    await tick(800);
    expect((lastFrame() ?? "").replace(/\s+/g, " ")).toContain("RESULT · INSTALL");
    expect(existsSync(join(canonicalSkillsRoot(home), "nueva-skill", "SKILL.md"))).toBe(true);
    unmount();
  });

  it("una fuente con varias skills abre la selección explícita y exige elegir", async () => {
    const ctx = buildCtx(home);
    const source = join(workdir, "coleccion");
    await makeSkillDir(join(source, "skills"), "tool-design");
    await makeSkillDir(join(source, "skills"), "evaluation");

    const { lastFrame, stdin, unmount } = render(<SkillsTab ctx={ctx} isActive={true} />);
    await tick();
    stdin.write("a");
    await tick();
    stdin.write(source);
    await tick();
    stdin.write(ENTER);
    await tick(600);
    const selection = (lastFrame() ?? "").replace(/\s+/g, " ");
    expect(selection).toContain("SELECT SKILLS");
    // Cada candidata por nombre Y por ubicación dentro de la fuente (una fila
    // angosta recorta la ruta larga, pero su prefijo identifica el lugar).
    expect(selection).toContain("skills/evaluation");
    expect(selection).toContain("skills/tool-des");
    expect(selection).toContain("0 of 2 chosen");

    // Continuar sin elegir no prepara nada: lo explica y conserva la selección.
    stdin.write(ENTER);
    await tick(200);
    expect((lastFrame() ?? "").replace(/\s+/g, " ")).toContain("Choose at least one skill");

    stdin.write(" "); // elige la fila del cursor
    await tick(100);
    expect((lastFrame() ?? "").replace(/\s+/g, " ")).toContain("1 of 2 chosen");
    stdin.write(ENTER);
    await tick(800);
    const preview = (lastFrame() ?? "").replace(/\s+/g, " ");
    expect(preview).toContain("PROPOSED CHANGES · INSTALL");
    // Sólo la elegida entra: nunca su hermana.
    expect(preview).toContain("+ evaluation");
    expect(preview).not.toContain("+ tool-design");
    unmount();
  });

  // ===== SPEC 019 — filtro por defecto a la semilla + toggle `t` =====

  /** Registra una skill cuyo nombre NO figura en la semilla de recomendadas. */
  async function registerOutsideSeed(ctx: CliContext): Promise<void> {
    const src = await makeSkillDir(workdir, "fuera-de-semilla");
    await applyChange(ctx, { operation: "register", source: src });
  }

  it("abre filtrada: solo lista la semilla, con el modo anunciado y los totales globales intactos", async () => {
    const ctx = buildCtx(home);
    await registerOutsideSeed(ctx);

    const { lastFrame, unmount } = render(<SkillsTab ctx={ctx} isActive={true} />);
    await tick();
    const frame = (lastFrame() ?? "").replace(/\s+/g, " ");
    expect(frame).not.toContain("fuera-de-semilla");
    expect(frame).toContain("pdf"); // la semilla sí, cualquiera sea su estado
    expect(frame).toContain("recommended only · t show all"); // hint del SectionHead
    expect(frame).toContain("t show all"); // QuickAction
    // El PageHead sigue contando TODO lo detectado, no solo lo visible.
    expect(frame).toContain(
      `0 installed · 1 registered · ${RECOMMENDED_SKILLS.length} recommended`,
    );
    unmount();
  });

  it("`t` alterna a la lista completa y vuelve, anunciando el modo activo", async () => {
    const ctx = buildCtx(home);
    await registerOutsideSeed(ctx);

    const { lastFrame, stdin, unmount } = render(<SkillsTab ctx={ctx} isActive={true} />);
    await tick();
    stdin.write(TOGGLE);
    await tick();
    const all = (lastFrame() ?? "").replace(/\s+/g, " ");
    expect(all).toContain("fuera-de-semilla");
    expect(all).toContain("all skills · t show recommended");
    expect(all).toContain("t show recommended");

    stdin.write(TOGGLE);
    await tick();
    const back = (lastFrame() ?? "").replace(/\s+/g, " ");
    expect(back).not.toContain("fuera-de-semilla");
    expect(back).toContain("recommended only · t show all");
    unmount();
  });

  it("reabrir la pestaña vuelve al modo filtrado (el toggle no persiste)", async () => {
    const ctx = buildCtx(home);
    await registerOutsideSeed(ctx);

    // Salir de la pestaña la desmonta (app.tsx la renderiza condicionalmente).
    const first = render(<SkillsTab ctx={ctx} isActive={true} />);
    await tick();
    first.stdin.write(TOGGLE);
    await tick();
    expect(first.lastFrame() ?? "").toContain("fuera-de-semilla");
    first.unmount();

    const again = render(<SkillsTab ctx={ctx} isActive={true} />);
    await tick();
    const frame = (again.lastFrame() ?? "").replace(/\s+/g, " ");
    expect(frame).not.toContain("fuera-de-semilla");
    expect(frame).toContain("recommended only · t show all");
    again.unmount();
  });

  it("windowing: acota la lista al viewport y la última skill queda visible al llegar abajo", async () => {
    const ctx = buildCtx(home);
    // The recommended seed alone overflows a rows=20 viewport (chrome reserves
    // 22 rows). The manager's own order decides which skill is last.
    const all = await listSkills(ctx, RECOMMENDED_SKILLS);
    const total = all.length;
    const lastName = all[total - 1]?.name ?? "";

    const { lastFrame, stdin, stdout, unmount } = render(<SkillsTab ctx={ctx} isActive={true} />);
    await tick();
    // ink-testing-library's fake stdout has no `rows`: fake a 20-row TTY + resize.
    const fake = stdout as EventEmitter & { rows?: number };
    fake.rows = 20;
    fake.emit("resize");
    await tick();

    for (let i = 0; i < total - 1; i++) {
      stdin.write(DOWN);
      await tick(30);
    }

    const frame = lastFrame() ?? "";
    expect(frame).toContain(lastName); // the cursor reached the last skill
    expect(frame.split("\n").length).toBeLessThanOrEqual(20);
    expect(frame).toContain(`de ${total}`); // range indicator in the hint slot
    unmount();
  }, 15000);
  // ===== SPEC 043 — instalación y recomendación son hechos distintos =====

  it("el detalle separa estado de recomendación y enuncia condición y límites", async () => {
    const ctx = buildCtx(home);
    // Fuente local homónima de una entrada del catálogo: la fila queda
    // installed y su fuente registrada NO es la del catálogo.
    const src = await makeSkillDir(workdir, "pdf");
    await applyChange(ctx, { operation: "install", source: src });

    const { lastFrame, stdin, unmount } = render(<SkillsTab ctx={ctx} isActive={true} />);
    await tick();
    stdin.write(ENTER); // 'pdf' encabeza: installed va antes que recommended
    await tick();
    const frame = (lastFrame() ?? "").replace(/\s+/g, " ");

    expect(frame).toContain("Status: installed");
    expect(frame).toContain("Recommendation: conditional");
    expect(frame).toContain("Use when:");
    expect(frame).toContain("Known limits:");
    // La fuente mostrada es la instalada, no la del catálogo: se lee entera
    // aunque el panel la parta en varias líneas.
    expect(dense(lastFrame() ?? "")).toContain(`Source:${pathHead(src)}`);
    unmount();
  });

  it("una retirada instalada aparece en `all` con su veredicto, no en la lista habitual", async () => {
    const ctx = buildCtx(home);
    // `checklist-discipline` es una de las cuatro retiradas y no es subcadena
    // de ninguna otra entrada del catálogo.
    const src = await makeSkillDir(workdir, "checklist-discipline");
    await applyChange(ctx, { operation: "install", source: src });

    const { lastFrame, stdin, unmount } = render(<SkillsTab ctx={ctx} isActive={true} />);
    await tick();
    expect((lastFrame() ?? "").replace(/\s+/g, " ")).not.toContain("checklist-discipline");

    stdin.write(TOGGLE);
    await tick();
    const all = (lastFrame() ?? "").replace(/\s+/g, " ");
    expect(all).toContain("checklist-discipline");
    expect(all).toContain("withdrawn");

    stdin.write(ENTER);
    await tick();
    expect((lastFrame() ?? "").replace(/\s+/g, " ")).toContain("Recommendation: withdrawn");
    // Cambiar la recomendación no toca archivos: la instalación sigue ahí.
    expect(existsSync(join(canonicalSkillsRoot(home), "checklist-discipline"))).toBe(true);
    unmount();
  });

  it("consultar, filtrar y cancelar no cambia ninguna instalación ni el registro", async () => {
    const ctx = buildCtx(home);
    const { stdin, unmount } = render(<SkillsTab ctx={ctx} isActive={true} />);
    await tick();
    stdin.write(ENTER); // detalle de una recomendada
    await tick();
    stdin.write(ESC); // vuelve a la lista
    await tick();
    stdin.write(TOGGLE); // all
    await tick();
    stdin.write(TOGGLE); // y vuelve
    await tick();

    expect(existsSync(canonicalSkillsRoot(home))).toBe(false);
    expect(existsSync(skillsRegistryPath(home))).toBe(false);
    unmount();
  });
});
