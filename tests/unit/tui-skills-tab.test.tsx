import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { installSkill, registerSkill } from "../../src/application/self/skills-manager.js";
import { RECOMMENDED_SKILLS } from "../../src/cli/tui/data/recommended-skills.js";
import { SkillsTab } from "../../src/cli/tui/tabs/skills-tab.js";
import type { CliContext } from "../../src/cli/types.js";
import type { EnvPort } from "../../src/ports/env.js";

const ENTER = "\r";
const DOWN = "\x1B[B";
const tick = (ms = 120) => new Promise((r) => setTimeout(r, ms));

class FakeEnv implements EnvPort {
  constructor(private home: string) {}
  get() {
    return undefined;
  }
  homeDir() {
    return this.home;
  }
  cwd() {
    return this.home;
  }
}

// El tab usa skills-manager de verdad contra un home sandbox (adapter real):
// listSkills/register/install operan sobre tmpdir, nunca el HOME del dev.
function buildCtx(home: string): CliContext {
  return { fs: new NodeFileSystem(), env: new FakeEnv(home) } as unknown as CliContext;
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
    await registerSkill(ctx, { source: src });

    const { lastFrame, unmount } = render(<SkillsTab ctx={ctx} isActive={true} />);
    await tick();
    const frame = (lastFrame() ?? "").replace(/\s+/g, " ");
    expect(frame).toContain(
      `0 installed · 1 registered · ${RECOMMENDED_SKILLS.length} recommended`,
    );
    // Orden: la registrada primero (cursor arranca ahí).
    expect(frame.indexOf("mi-skill")).toBeLessThan(frame.indexOf("codebase-design"));
    unmount();
  });

  it("⏎ sobre una recomendada abre el detail con Install y su descripción", async () => {
    const { lastFrame, stdin, unmount } = render(
      <SkillsTab ctx={buildCtx(home)} isActive={true} />,
    );
    await tick();
    stdin.write(ENTER); // primera fila (recommended, orden alfabético)
    await tick();
    const frame = (lastFrame() ?? "").replace(/\s+/g, " ");
    expect(frame).toContain("Install");
    expect(frame).toContain("Register + install");
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

  it("una instalada de fuente LOCAL ofrece Reinstall/Uninstall/Remove pero NO Update", async () => {
    const ctx = buildCtx(home);
    const src = await makeSkillDir(workdir, "local-skill");
    await registerSkill(ctx, { source: src });
    await installSkill(ctx, "local-skill");

    const { lastFrame, stdin, unmount } = render(<SkillsTab ctx={ctx} isActive={true} />);
    await tick();
    stdin.write(ENTER); // primera fila = la instalada (orden del manager)
    await tick();
    const frame = (lastFrame() ?? "").replace(/\s+/g, " ");
    expect(frame).toContain("Reinstall");
    expect(frame).toContain("Uninstall");
    expect(frame).toContain("Remove");
    // Update es solo para fuentes git (clasificador canónico, no startsWith("/")).
    expect(frame).not.toContain("Update");
    unmount();
  });

  it("Uninstall pide confirmación y al confirmar la skill vuelve a registered", async () => {
    const ctx = buildCtx(home);
    const src = await makeSkillDir(workdir, "local-skill");
    await registerSkill(ctx, { source: src });
    await installSkill(ctx, "local-skill");

    const { lastFrame, stdin, unmount } = render(<SkillsTab ctx={ctx} isActive={true} />);
    await tick();
    stdin.write(ENTER); // detail (acciones: Reinstall, Uninstall, Remove)
    await tick();
    stdin.write(DOWN); // → Uninstall
    await tick(40);
    stdin.write(ENTER);
    await tick();
    expect((lastFrame() ?? "").replace(/\s+/g, " ")).toContain("Uninstall local-skill?");

    stdin.write("y");
    await tick(400);
    const after = (lastFrame() ?? "").replace(/\s+/g, " ");
    expect(after).toContain(
      `0 installed · 1 registered · ${RECOMMENDED_SKILLS.length} recommended`,
    );
    unmount();
  });

  it("Remove de una recomendada registrada la devuelve a recommended (AC6, a nivel tab)", async () => {
    const ctx = buildCtx(home);
    // Fuente local cuyo skill-dir se llama como una recomendada de la semilla.
    const src = await makeSkillDir(workdir, "pdf");
    await registerSkill(ctx, { source: src });

    const { lastFrame, stdin, unmount } = render(<SkillsTab ctx={ctx} isActive={true} />);
    await tick();
    stdin.write(ENTER); // detail de 'pdf' (registered → Install, Remove)
    await tick();
    stdin.write(DOWN); // → Remove
    await tick(40);
    stdin.write(ENTER);
    await tick();
    expect((lastFrame() ?? "").replace(/\s+/g, " ")).toContain("Remove pdf?");

    stdin.write("y");
    await tick(400);
    const after = (lastFrame() ?? "").replace(/\s+/g, " ");
    // Nunca desaparece: vuelve al estado recommended de la semilla.
    expect(after).toContain(
      `0 installed · 0 registered · ${RECOMMENDED_SKILLS.length} recommended`,
    );
    expect(after).toContain("pdf");
    unmount();
  });

  it("wizard happy-path: fuente local → warning de terceros → [r] registra", async () => {
    const ctx = buildCtx(home);
    const src = await makeSkillDir(workdir, "nueva-skill");
    const { lastFrame, stdin, unmount } = render(<SkillsTab ctx={ctx} isActive={true} />);
    await tick();
    stdin.write("a");
    await tick();
    stdin.write(src); // path absoluto de la fuente
    await tick();
    stdin.write(ENTER); // inspecciona (probe) → 1 candidata → warning directo
    await tick(300);
    const warning = (lastFrame() ?? "").replace(/\s+/g, " ");
    expect(warning).toContain("runs with your host's permissions");
    expect(warning).toContain("register + install");

    stdin.write("r"); // registrar sin instalar
    await tick(400);
    const after = (lastFrame() ?? "").replace(/\s+/g, " ");
    expect(after).toContain(`1 registered · ${RECOMMENDED_SKILLS.length} recommended`);
    expect(after).toContain("nueva-skill");
    unmount();
  });
});
