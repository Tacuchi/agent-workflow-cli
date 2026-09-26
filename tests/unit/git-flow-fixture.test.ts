import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GitCliAdapter } from "../../src/adapters/git-cli.js";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { NodeProcess } from "../../src/adapters/node-process.js";
import { type GitFlowInput, runGitFlow } from "../../src/application/git-flow-service.js";
import { PathsService } from "../../src/application/paths-service.js";
import { attributeTuiKeypress, grantProdConsent } from "../../src/application/prod-consent.js";
import { renderProjectBlock } from "../../src/application/render/project-block.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";

/**
 * Los escenarios de la spec 051 sobre git real: repos temporales y un `origin`
 * desnudo local, sin red. Lo que se afirma es sobre merges y refs — qué commit
 * queda en qué rama —, y eso un doble no lo puede demostrar.
 */

const PROD = "certificacion";
const DEV = "desarrollo";
const WORK = "feature/x";

/** Git config the fixture cannot inherit: the person's globals would decide merges. */
const ISOLATED_ENV: Record<string, string> = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
};

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  }).trim();
}

const sha = (repo: string, ref: string): string => git(repo, "rev-parse", ref);

function contains(repo: string, commit: string, branch: string): boolean {
  try {
    git(repo, "merge-base", "--is-ancestor", commit, branch);
    return true;
  } catch {
    return false;
  }
}

function commitFile(repo: string, file: string, text: string): string {
  writeFileSync(join(repo, file), text);
  git(repo, "add", file);
  git(repo, "commit", "-q", "-m", `add ${file}`);
  return sha(repo, "HEAD");
}

describe("git-flow sobre git real: cada rama sólo desde su homónima, PROD sólo hacia adelante", () => {
  const saved: Record<string, string | undefined> = {};
  let root: string;
  let origin: string;
  let other: string;
  let source: string;
  let workspace: string;

  beforeAll(() => {
    const globals = mkdtempSync(join(tmpdir(), "aw-gitflow-globals-"));
    writeFileSync(join(globals, "gitconfig"), "");
    const env = { ...ISOLATED_ENV, GIT_CONFIG_GLOBAL: join(globals, "gitconfig") };
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
    root = mkdtempSync(join(tmpdir(), "aw-gitflow-fixture-"));
    origin = join(root, "origin.git");
    other = join(root, "other");
    source = join(root, "source");
    workspace = join(root, "workspace");
    execFileSync("mkdir", ["-p", workspace]);

    git(root, "init", "-q", "--bare", "-b", PROD, origin);
    git(root, "clone", "-q", origin, other);
    commitFile(other, "base.txt", "base\n");
    git(other, "push", "-q", "origin", PROD);
    for (const branch of [DEV, WORK]) {
      git(other, "branch", branch, PROD);
      git(other, "push", "-q", "origin", branch);
    }
    git(root, "clone", "-q", origin, source);
    git(source, "checkout", "-q", WORK);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Push one commit to `branch` in origin from the second clone. */
  function advanceOrigin(branch: string, file: string): string {
    git(other, "fetch", "-q", "origin");
    git(other, "checkout", "-q", "-B", branch, `origin/${branch}`);
    const commit = commitFile(other, file, `${file}\n`);
    git(other, "push", "-q", "origin", branch);
    return commit;
  }

  async function flow(input: GitFlowInput, work = WORK, prod = PROD) {
    const paths = new PathsService(normalizeNamespace("agent-workflow"), workspace, workspace);
    const block = renderProjectBlock({
      proyecto: "Fixture",
      fuentes: [{ alias: "core", path: source, main_branch: prod }],
      stack: {},
      lastActivity: "2026-01-01 00:00",
      defaultBranches: { desarrollo: DEV },
      workingBranches: { core: work },
      qaBranches: {},
      markers: paths.blockMarkers(),
    });
    writeFileSync(join(workspace, "CLAUDE.md"), block, "utf8");
    return runGitFlow(new NodeFileSystem(), new GitCliAdapter(new NodeProcess()), paths, input);
  }

  /** Publish as the person's yes would: preview, consent for that exact plan, run. */
  async function publish(input: GitFlowInput) {
    const need = (await flow(input)).consent_required;
    if (need === undefined) throw new Error("the input publishes nothing in PROD");
    const consent = grantProdConsent(attributeTuiKeypress(new FakeEnv()), need.sources, need.plan);
    return flow({ ...input, consent: consent ?? undefined });
  }

  it("con varios heads en el fetch, PROD queda igual a su remoto y sin merge nuevo", async () => {
    // GIT-01: la configuración de rastreo de PROD mezcla dos heads; `git pull`
    // armaba con eso un octopus en certificacion.
    git(source, "config", "--add", `branch.${PROD}.merge`, `refs/heads/${DEV}`);
    const devCommit = advanceOrigin(DEV, "dev.txt");
    advanceOrigin(PROD, "prod.txt");

    const result = await flow({ action: "sync", source: "core" });

    expect(result.status).toBe("ok");
    expect(sha(source, PROD)).toBe(sha(source, `origin/${PROD}`));
    expect(git(source, "rev-list", "--merges", PROD)).toBe("");
    // Traído, el commit de desarrollo existe en el repo: la aserción no es trivial.
    git(source, "fetch", "-q", "origin");
    expect(contains(source, devCommit, PROD)).toBe(false);
  });

  it("una rama de trabajo que rastrea origin/desarrollo no recibe sus commits", async () => {
    git(source, "branch", "--set-upstream-to", `origin/${DEV}`, WORK);
    const devCommit = advanceOrigin(DEV, "dev.txt");

    const result = await flow({ action: "sync", source: "core" });

    expect(result.status).toBe("ok");
    git(source, "fetch", "-q", "origin");
    expect(contains(source, devCommit, WORK)).toBe(false);
  });

  it("una rama sin rastreo recibe su homónima y la rama de PROD sin fallar", async () => {
    git(source, "branch", "--unset-upstream", WORK);
    const workCommit = advanceOrigin(WORK, "work.txt");
    const prodCommit = advanceOrigin(PROD, "prod.txt");

    const result = await flow({ action: "sync", source: "core" });

    expect(result.status).toBe("ok");
    expect(contains(source, workCommit, WORK)).toBe(true);
    expect(contains(source, prodCommit, WORK)).toBe(true);
  });

  it("una rama de trabajo sin homónima en origin omite su paso y recibe PROD", async () => {
    git(source, "checkout", "-q", "--no-track", "-b", "feature/local", PROD);
    const prodCommit = advanceOrigin(PROD, "prod.txt");

    const result = await flow({ action: "sync", source: "core" }, "feature/local");

    expect(result.status).toBe("ok");
    expect(result.results[0]?.steps[0]).toMatchObject({ status: "skipped" });
    expect(contains(source, prodCommit, "feature/local")).toBe(true);
  });

  it("sin el remoto de PROD, sync se detiene sin moverla y dice por qué", async () => {
    git(source, "branch", "produccion", PROD);
    const before = sha(source, "produccion");

    const result = await flow({ action: "sync", source: "core" }, WORK, "produccion");

    expect(result.status).toBe("error");
    expect(result.results[0]?.error).toMatch(/origin no tiene produccion/);
    expect(sha(source, "produccion")).toBe(before);
  });

  it("PROD adelantada con commits ajenos a la rama de trabajo se detiene sin moverla", async () => {
    git(source, "checkout", "-q", PROD);
    const foreign = commitFile(source, "ajeno.txt", "ajeno\n");
    git(source, "checkout", "-q", WORK);

    const result = await flow({ action: "sync", source: "core" });

    expect(result.status).toBe("error");
    expect(result.results[0]?.error).toMatch(new RegExp(foreign.slice(0, 7)));
    expect(sha(source, PROD)).toBe(foreign);
    expect(contains(source, foreign, WORK)).toBe(false);
  });

  it("PROD divergida de su remoto se detiene sin moverla", async () => {
    git(source, "checkout", "-q", PROD);
    const local = commitFile(source, "local.txt", "local\n");
    git(source, "checkout", "-q", WORK);
    advanceOrigin(PROD, "remoto.txt");

    const result = await flow({ action: "sync", source: "core" });

    expect(result.status).toBe("error");
    expect(result.results[0]?.error).toMatch(/divergió/);
    expect(sha(source, PROD)).toBe(local);
  });

  it("sync con destino PROD divergida se detiene: nunca la mezcla con su remoto", async () => {
    git(source, "checkout", "-q", PROD);
    const local = commitFile(source, "local.txt", "local\n");
    advanceOrigin(PROD, "remoto.txt");

    const result = await flow({ action: "sync", source: "core", target: PROD });

    expect(result.status).toBe("error");
    expect(result.results[0]?.error).toMatch(/divergió/);
    expect(sha(source, PROD)).toBe(local);
  });

  it("un tag con el nombre de PROD no oculta un commit ajeno en la rama", async () => {
    git(source, "tag", PROD, PROD);
    git(source, "checkout", "-q", PROD);
    const foreign = commitFile(source, "ajeno.txt", "ajeno\n");
    git(source, "checkout", "-q", WORK);

    const result = await flow({ action: "sync", source: "core" });

    expect(result.status).toBe("error");
    expect(result.results[0]?.error).toMatch(new RegExp(foreign.slice(0, 7)));
  });

  it("con merge.ff=false, repetir to-prod tras un push fallido igual completa la publicación", async () => {
    git(source, "config", "merge.ff", "false");
    const marker = join(root, "rechazar-push");
    const hook = join(origin, "hooks", "pre-receive");
    writeFileSync(hook, `#!/bin/sh\n[ -f "${marker}" ] && exit 1\nexit 0\n`);
    chmodSync(hook, 0o755);
    writeFileSync(marker, "");
    commitFile(source, "feature.txt", "feature\n");

    expect((await publish({ action: "to-prod", source: "core" })).status).toBe("error");
    rmSync(marker);
    const retried = await publish({ action: "to-prod", source: "core" });

    expect(retried.status).toBe("ok");
    git(source, "fetch", "-q", "origin");
    expect(sha(source, `origin/${PROD}`)).toBe(sha(source, PROD));
  });

  it("tras un push a PROD que no llegó, repetir to-prod completa la publicación", async () => {
    const marker = join(root, "rechazar-push");
    const hook = join(origin, "hooks", "pre-receive");
    writeFileSync(hook, `#!/bin/sh\n[ -f "${marker}" ] && exit 1\nexit 0\n`);
    chmodSync(hook, 0o755);
    writeFileSync(marker, "");
    const feature = commitFile(source, "feature.txt", "feature\n");

    const failed = await publish({ action: "to-prod", source: "core" });

    expect(failed.status).toBe("error");
    expect(failed.results[0]?.error).toMatch(/push certificacion failed/);
    expect(contains(source, feature, PROD)).toBe(true);
    expect(contains(source, feature, `origin/${PROD}`)).toBe(false);

    rmSync(marker);
    const retried = await publish({ action: "to-prod", source: "core" });

    expect(retried.status).toBe("ok");
    git(source, "fetch", "-q", "origin");
    expect(sha(source, `origin/${PROD}`)).toBe(sha(source, PROD));
    expect(contains(source, feature, `origin/${PROD}`)).toBe(true);
  });
});
