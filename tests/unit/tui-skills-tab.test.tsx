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
import { FakeEnv } from "../helpers/fake-env.js";

const ENTER = "\r";
const DOWN = "\x1B[B";
const tick = (ms = 120) => new Promise((r) => setTimeout(r, ms));

// The tab uses the real skills-manager against a sandbox home (real adapter):
// listSkills/register/install operate on a tmpdir, never the dev's HOME.
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
    const frame = (lastFrame() ?? "").replace(/\s+/g, " ");
    expect(frame).toContain(
      `0 installed · 1 unmanaged · 0 registered · ${RECOMMENDED_SKILLS.length} recommended`,
    );
    expect(frame).toContain("ajena");
    expect(frame).toContain("softaworks/agent-toolkit");

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
    stdin.write(ENTER); // first row = the installed one (manager order)
    await tick();
    const frame = (lastFrame() ?? "").replace(/\s+/g, " ");
    expect(frame).toContain("Reinstall");
    expect(frame).toContain("Uninstall");
    expect(frame).toContain("Remove");
    // Update is git-sources-only (canonical classifier, not startsWith("/")).
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
    stdin.write(ENTER); // detail (actions: Reinstall, Uninstall, Remove)
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
    // Local source whose skill dir is named like one of the seed's recommended skills.
    const src = await makeSkillDir(workdir, "pdf");
    await registerSkill(ctx, { source: src });

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
    const after = (lastFrame() ?? "").replace(/\s+/g, " ");
    // It never disappears: it returns to the seed's recommended state.
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
    stdin.write(src); // absolute path of the source
    await tick();
    stdin.write(ENTER); // inspects (probe) → 1 candidate → straight to the warning
    await tick(300);
    const warning = (lastFrame() ?? "").replace(/\s+/g, " ");
    expect(warning).toContain("runs with your host's permissions");
    expect(warning).toContain("register + install");

    stdin.write("r"); // register without installing
    await tick(400);
    const after = (lastFrame() ?? "").replace(/\s+/g, " ");
    expect(after).toContain(`1 registered · ${RECOMMENDED_SKILLS.length} recommended`);
    expect(after).toContain("nueva-skill");
    unmount();
  });
});
