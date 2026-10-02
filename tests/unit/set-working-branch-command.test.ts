import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GitCliAdapter } from "../../src/adapters/git-cli.js";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { NodeProcess } from "../../src/adapters/node-process.js";
import { PathsService } from "../../src/application/paths-service.js";
import { renderHubBlock } from "../../src/application/render/hub-block.js";
import { setWorkingBranchCommand } from "../../src/cli/commands/set-branch.js";
import type { ParsedArgs } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";

/**
 * `aw set-working-branch` sobre git real (AC-05, AC-11 de la spec 051): repos
 * temporales y un `origin` desnudo local, con la configuración global de git
 * aislada — un `push.default=matching` de la persona cambiaría lo que un push
 * sin argumentos escribe.
 */

const PROD = "certificacion";

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  }).trim();
}

function fails(repo: string, ...args: string[]): boolean {
  try {
    git(repo, ...args);
    return false;
  } catch {
    return true;
  }
}

function commitFile(repo: string, file: string): string {
  writeFileSync(join(repo, file), `${file}\n`);
  git(repo, "add", file);
  git(repo, "commit", "-q", "-m", `add ${file}`);
  return git(repo, "rev-parse", "HEAD");
}

function args(rest: string[]): ParsedArgs {
  return { rest, plugin: {}, flags: new Set(), values: new Map(), valuesMulti: new Map() };
}

describe("aw set-working-branch resuelve la rama antes de registrarla", () => {
  const saved: Record<string, string | undefined> = {};
  let root: string;
  let origin: string;
  let other: string;
  let source: string;
  let hub: string;

  beforeAll(() => {
    const globals = mkdtempSync(join(tmpdir(), "aw-swb-globals-"));
    writeFileSync(join(globals, "gitconfig"), "");
    const env: Record<string, string> = {
      GIT_CONFIG_GLOBAL: join(globals, "gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.com",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.com",
    };
    for (const [key, value] of Object.entries(env)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
  });
  afterAll(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "aw-swb-"));
    origin = join(root, "origin.git");
    other = join(root, "other");
    source = join(root, "source");
    hub = join(root, "workspace");
    mkdirSync(hub);
    git(root, "init", "-q", "--bare", "-b", PROD, origin);
    git(root, "clone", "-q", origin, other);
    commitFile(other, "base.txt");
    git(other, "push", "-q", "origin", PROD);
    git(root, "clone", "-q", origin, source);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function declare(prod = PROD): CliContext {
    const paths = new PathsService(normalizeNamespace("agent-workflow"), hub, hub);
    const block = renderHubBlock({
      proyecto: "Fixture",
      fuentes: [{ alias: "core", path: source, main_branch: prod }],
      stack: {},
      lastActivity: "2026-01-01 00:00",
      workingBranches: {},
      qaBranches: {},
      markers: paths.blockMarkers(),
    });
    writeFileSync(join(hub, "AGENTS.md"), block, "utf8");
    return {
      fs: new NodeFileSystem(),
      env: new FakeEnv(hub),
      paths,
      git: new GitCliAdapter(new NodeProcess()),
    } as unknown as CliContext;
  }

  const registered = (branch: string) =>
    readFileSync(join(hub, "AGENTS.md"), "utf8").includes(`  - core: ${branch}`);

  it("una rama que ya existe en local se registra como hoy", async () => {
    git(source, "branch", "feature/local", PROD);
    const result = await setWorkingBranchCommand.execute(
      args(["core", "feature/local"]),
      declare(),
    );

    expect(result.ok).toBe(true);
    expect((result.data as { working_branch: { outcome: string } }).working_branch.outcome).toBe(
      "existing",
    );
    expect(registered("feature/local")).toBe(true);
  });

  it("una rama que sólo está en origin se trae rastreando su homónima", async () => {
    git(other, "push", "-q", "origin", `${PROD}:refs/heads/feature/remota`);

    const result = await setWorkingBranchCommand.execute(
      args(["core", "feature/remota"]),
      declare(),
    );

    expect(result.ok).toBe(true);
    expect(git(source, "rev-parse", "--abbrev-ref", "feature/remota@{upstream}")).toBe(
      "origin/feature/remota",
    );
    expect(git(source, "rev-parse", "feature/remota")).toBe(git(origin, "rev-parse", PROD));
    expect(registered("feature/remota")).toBe(true);
  });

  it("una rama que no existe se crea sin rastreo desde la rama de PROD recién traída", async () => {
    // Un commit empujado DESPUÉS del clon: la rama nueva sólo puede partir de
    // él si el comando trajo PROD antes de crearla.
    const fresh = commitFile(other, "nuevo.txt");
    git(other, "push", "-q", "origin", PROD);
    const originProd = () => git(origin, "rev-parse", PROD);

    const result = await setWorkingBranchCommand.execute(
      args(["core", "feature/nueva"]),
      declare(),
    );

    expect(result.ok).toBe(true);
    expect(git(source, "rev-parse", "feature/nueva")).toBe(fresh);
    expect(fails(source, "rev-parse", "--abbrev-ref", "feature/nueva@{upstream}")).toBe(true);
    expect(registered("feature/nueva")).toBe(true);

    // Con el push.default por defecto, un push y un pull sin argumentos sobre
    // ella no escriben en PROD ni la mezclan.
    git(source, "checkout", "-q", "feature/nueva");
    commitFile(source, "trabajo.txt");
    const before = originProd();
    expect(fails(source, "push")).toBe(true);
    expect(fails(source, "pull")).toBe(true);
    expect(originProd()).toBe(before);
    expect(git(source, "rev-parse", "HEAD")).not.toBe(before);
  });

  it("si la creación falla, la rama no queda registrada", async () => {
    // La rama de PROD declarada no existe en origin: no hay desde dónde crearla.
    const result = await setWorkingBranchCommand.execute(
      args(["core", "feature/nueva"]),
      declare("produccion"),
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("WORKING_BRANCH_UNRESOLVED");
    expect(result.error?.message).toMatch(/origin no tiene la rama de PROD produccion/);
    expect(registered("feature/nueva")).toBe(false);
    expect(fails(source, "rev-parse", "--verify", "refs/heads/feature/nueva")).toBe(true);
  });

  it("un nombre que git no acepta como rama no se crea ni se registra", async () => {
    const result = await setWorkingBranchCommand.execute(args(["core", "bad..name"]), declare());

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("WORKING_BRANCH_UNRESOLVED");
    expect(registered("bad..name")).toBe(false);
  });

  it("una rama que existe en local y en origin se registra como existente, sin tocar su upstream", async () => {
    git(source, "branch", "--no-track", "feature/ambas", PROD);
    git(other, "push", "-q", "origin", `${PROD}:refs/heads/feature/ambas`);

    const result = await setWorkingBranchCommand.execute(
      args(["core", "feature/ambas"]),
      declare(),
    );

    expect((result.data as { working_branch: { outcome: string } }).working_branch.outcome).toBe(
      "existing",
    );
    expect(fails(source, "rev-parse", "--abbrev-ref", "feature/ambas@{upstream}")).toBe(true);
  });

  it("un nombre que difiere de una rama existente sólo en mayúsculas se rechaza sin crear nada", async () => {
    git(source, "branch", "Feature/Loc", PROD);

    const result = await setWorkingBranchCommand.execute(args(["core", "feature/loc"]), declare());

    expect(result.error?.code).toBe("WORKING_BRANCH_UNRESOLVED");
    expect(result.error?.message).toMatch(/ya existe Feature\/Loc/);
    expect(registered("feature/loc")).toBe(false);
  });

  it("en un clon de una sola rama no se crea: un pull sin argumentos mezclaría PROD", async () => {
    rmSync(source, { recursive: true, force: true });
    git(root, "clone", "-q", "--single-branch", "-b", PROD, origin, source);

    const result = await setWorkingBranchCommand.execute(
      args(["core", "feature/nueva"]),
      declare(),
    );

    expect(result.error?.code).toBe("WORKING_BRANCH_UNRESOLVED");
    expect(result.error?.message).toMatch(/no trae todas las ramas de origin/);
    expect(fails(source, "rev-parse", "--verify", "refs/heads/feature/nueva")).toBe(true);
    expect(registered("feature/nueva")).toBe(false);
  });

  it("un alias que no es fuente declarada se registra como hoy y dice que no se comprobó", async () => {
    const result = await setWorkingBranchCommand.execute(args(["otra", "feature/z"]), declare());

    expect(result.ok).toBe(true);
    expect((result.data as { working_branch: { notice: string } }).working_branch.notice).toMatch(
      /otra no es una fuente declarada: la rama feature\/z se registró sin comprobarla ni crearla/,
    );
    expect(readFileSync(join(hub, "AGENTS.md"), "utf8")).toContain("  - otra: feature/z");
  });
});
