import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { GitCliAdapter } from "../../src/adapters/git-cli.js";
import { NodeProcess } from "../../src/adapters/node-process.js";
import { hubsFile, readHubs, registerHub } from "../../src/application/hub-registry.js";
import { readWorkspaceBlock } from "../../src/application/parsers/project-block.js";
import { PathsService } from "../../src/application/paths-service.js";
import { applyRetirement } from "../../src/application/retirement/apply.js";
import { prepareRetirement } from "../../src/application/retirement/prepare.js";
import { runSessionCreate } from "../../src/application/session-create-service.js";
import { runVisibilityDoctor } from "../../src/application/visibility-doctor-service.js";
import { moveWorkspace } from "../../src/application/workspace-move-service.js";
import { runWorktree } from "../../src/application/worktree-service.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { NodeFileSystem } from "../helpers/real-fs.js";

const git = promisify(execFile);
const fs = new NodeFileSystem();
let temp: string | null = null;
afterEach(async () => {
  if (temp) await rm(temp, { recursive: true, force: true });
  temp = null;
});

it("mueve un hub y conserva una fuente relativa externa; dry-run no escribe", async () => {
  temp = await mkdtemp(join(tmpdir(), "aw-move-"));
  const home = join(temp, "home");
  const old = join(temp, "hub-old");
  const next = join(temp, "hub-new");
  const source = join(temp, "source");
  await mkdir(home);
  await mkdir(source);
  await git("git", ["init", "-q", source]);
  await mkdir(join(old, ".workflow", "sessions"), { recursive: true });
  await writeFile(join(old, ".workflow", "workline.json"), '{"namespace":"workflow"}');
  await writeFile(
    join(old, "AGENTS.md"),
    "<!-- WORKFLOW-HUB-START -->\n## Fuentes\n| Alias | Path | Rama principal |\n|---|---|---|\n| src | ../source | main |\n<!-- WORKFLOW-HUB-END -->",
  );
  const paths = new PathsService(normalizeNamespace("workflow"), home, old);
  await registerHub(fs, paths, old);
  const dry = await moveWorkspace(fs, paths, { destination: next, repair: false, dryRun: true });
  expect(dry.changes).toContain("fuente externa src fijada en local.json");
  await expect(fs.exists(next)).resolves.toBe(false);
  const moved = await moveWorkspace(fs, paths, { destination: next, repair: false, dryRun: false });
  expect(moved.to).toBe(next);
  const relocated = new PathsService(paths.namespace, home, next);
  expect((await readWorkspaceBlock(fs, next, relocated.blockMarkers()))?.fuentes[0]?.path).toBe(
    source,
  );
  expect(await readHubs(hubsFile(home, "workflow"))).toEqual([await realpath(next)]);
  expect(await readFile(relocated.cwdLocalConfigFile(), "utf8")).toContain(source);
  expect(await moveWorkspace(fs, relocated, { repair: true, dryRun: false })).toMatchObject({
    moved: false,
    changes: [],
  });
});

it("mueve y repara sin interpretar ni reescribir lanzadores, registro y logs legacy", async () => {
  temp = await mkdtemp(join(tmpdir(), "aw-move-legacy-"));
  const home = join(temp, "home");
  const old = join(temp, "anterior");
  const next = join(temp, "nuevo");
  await mkdir(home);
  await mkdir(join(old, ".workflow", "sessions"), { recursive: true });
  await writeFile(join(old, ".workflow", "workline.json"), '{"workline":1,"namespace":"workflow"}');
  const launch = join(".workflow", "launch", "app", "run.sh");
  const registry = join(".workflow", "processes.json");
  const log = join("docs", "logs", "app.log");
  await mkdir(join(old, ".workflow", "launch", "app"), { recursive: true });
  await mkdir(join(old, "docs", "logs"), { recursive: true });
  const bytes = new Uint8Array([0, 255, 10, 42]);
  await writeFile(join(old, launch), bytes);
  await writeFile(join(old, registry), `registro no JSON; pid vivo ${process.pid}\n`);
  await writeFile(join(old, log), `log anterior: ${old}\n`);
  const paths = new PathsService(normalizeNamespace("workflow"), home, old);
  const preview = await moveWorkspace(fs, paths, {
    destination: next,
    repair: false,
    dryRun: true,
  });
  expect(preview.changes.join(" ")).not.toMatch(/processes\.json|launch|docs\/logs/);
  await moveWorkspace(fs, paths, { destination: next, repair: false, dryRun: false });
  expect(await readFile(join(next, launch))).toEqual(Buffer.from(bytes));
  expect(await readFile(join(next, registry), "utf8")).toBe(
    `registro no JSON; pid vivo ${process.pid}\n`,
  );
  expect(await readFile(join(next, log), "utf8")).toBe(`log anterior: ${old}\n`);
  expect(() => process.kill(process.pid, 0)).not.toThrow();
  const repair = await moveWorkspace(fs, new PathsService(paths.namespace, home, next), {
    repair: true,
    from: old,
    dryRun: false,
  });
  expect(repair.changes.join(" ")).not.toMatch(/processes\.json|launch|docs\/logs/);
  expect(await readFile(join(next, launch))).toEqual(Buffer.from(bytes));
  expect(await readFile(join(next, registry), "utf8")).toBe(
    `registro no JSON; pid vivo ${process.pid}\n`,
  );
  expect(await readFile(join(next, log), "utf8")).toBe(`log anterior: ${old}\n`);
});

it("repara un hub movido a mano con commits retenidos en una unidad de su propia fuente", async () => {
  temp = await mkdtemp(join(tmpdir(), "aw-repair-"));
  const home = join(temp, "home");
  const old = join(temp, "original");
  const next = join(temp, "movido");
  await mkdir(home);
  await mkdir(old);
  await git("git", ["init", "--initial-branch=main", old]);
  await git("git", ["-C", old, "config", "user.email", "t@example.com"]);
  await git("git", ["-C", old, "config", "user.name", "T"]);
  await writeFile(
    join(old, "AGENTS.md"),
    "<!-- WORKFLOW-HUB-START -->\n## Fuentes\n| Alias | Path | Rama principal |\n|---|---|---|\n| self | . | main |\n## Status\n- Ramas de trabajo actuales:\n  - self: main\n<!-- WORKFLOW-HUB-END -->",
  );
  await writeFile(join(old, "README.md"), "base\n");
  await git("git", ["-C", old, "add", "AGENTS.md", "README.md"]);
  await git("git", ["-C", old, "commit", "-m", "base"]);
  const paths = new PathsService(normalizeNamespace("workflow"), home, old);
  const session = await runSessionCreate(fs, paths, {
    type: "exec",
    name: "retenido-plan-exec",
    objetivo: "reparar",
  });
  if ("error" in session) throw Error(session.error);
  await writeFile(
    join(old, ".gitignore"),
    `${await readFile(join(old, ".gitignore"), "utf8")}\n.codex/\n`,
  );
  await git("git", [
    "-C",
    old,
    "add",
    ".gitignore",
    ".workflow/workline.json",
    ".workflow/HISTORY.md",
  ]);
  await git("git", ["-C", old, "commit", "-m", "runtime inicial"]);
  const taken = await runWorktree(
    { fs, env: new FakeEnv(home, old), git: new GitCliAdapter(new NodeProcess()), paths },
    { action: "ensure", alias: "self", sessionCode: session.sessionCreate.folder },
  );
  if ("error" in taken || !("path" in taken) || !("branch" in taken))
    throw Error(JSON.stringify(taken));
  await writeFile(join(taken.path, "retenido.txt"), "trabajo\n");
  await git("git", ["-C", taken.path, "add", "retenido.txt"]);
  await git("git", ["-C", taken.path, "commit", "-m", "trabajo retenido"]);
  await rename(old, next);
  const relocated = new PathsService(paths.namespace, home, next);
  const repaired = await moveWorkspace(fs, relocated, { repair: true, dryRun: false });
  expect(repaired.from).toBe(old);
  expect(repaired.warnings).toEqual([]);
  expect(
    await readFile(
      join(relocated.cwdSessionsDir(), session.sessionCreate.folder, ".custody.json"),
      "utf8",
    ),
  ).not.toContain(old);
  expect(await readFile(relocated.cwdLocalConfigFile(), "utf8")).toContain("previous_keys");
  const listed = await runWorktree(
    {
      fs,
      env: new FakeEnv(home, next),
      git: new GitCliAdapter(new NodeProcess()),
      paths: relocated,
    },
    { action: "list", sessionCode: session.sessionCreate.folder },
  );
  if ("error" in listed || !("units" in listed)) throw Error(JSON.stringify(listed));
  expect(listed.units).toMatchObject([{ path: taken.path, branch: taken.branch }]);
  expect(await readFile(join(taken.path, "retenido.txt"), "utf8")).toBe("trabajo\n");
  const visibility = await runVisibilityDoctor(fs, new FakeEnv(home, next), relocated, {});
  expect(visibility.reports.find((report) => report.host === "claude")?.extra).not.toContain(
    taken.path,
  );
  const integrated = await runWorktree(
    {
      fs,
      env: new FakeEnv(home, next),
      git: new GitCliAdapter(new NodeProcess()),
      paths: relocated,
    },
    { action: "integrate", alias: "self", sessionCode: session.sessionCreate.folder },
  );
  if ("error" in integrated)
    throw Error(
      `${JSON.stringify(integrated)}; ${JSON.stringify((await git("git", ["-C", next, "status", "--short"])).stdout)}`,
    );
  expect(await readFile(join(next, "retenido.txt"), "utf8")).toBe("trabajo\n");
});

it("no convalida ni re-sella una custodia editada a mano al reparar", async () => {
  temp = await mkdtemp(join(tmpdir(), "aw-repair-custody-"));
  const home = join(temp, "home");
  const old = join(temp, "old");
  const next = join(temp, "new");
  await mkdir(home);
  await mkdir(join(old, ".workflow", "sessions"), { recursive: true });
  await writeFile(join(old, ".workflow", "workline.json"), '{"workline":1,"namespace":"workflow"}');
  const paths = new PathsService(normalizeNamespace("workflow"), home, old);
  const session = await runSessionCreate(fs, paths, {
    type: "exec",
    name: "tamper-plan-exec",
    objetivo: "probar",
  });
  if ("error" in session) throw Error(session.error);
  const custodyFile = join(session.sessionCreate.path, ".custody.json");
  const tampered = (await readFile(custodyFile, "utf8")).replace(old, `${old}-editado`);
  await writeFile(custodyFile, tampered);
  await rename(old, next);
  const repaired = await moveWorkspace(fs, new PathsService(paths.namespace, home, next), {
    repair: true,
    from: old,
    dryRun: false,
  });
  expect(repaired.warnings).toEqual(
    expect.arrayContaining([expect.stringContaining("no se re-sella")]),
  );
  expect(
    await readFile(
      join(next, ".workflow", "sessions", session.sessionCreate.folder, ".custody.json"),
      "utf8",
    ),
  ).toBe(tampered);
});

it("un rename rechazado por el sistema explica el remedio y deja el hub en su sitio", async () => {
  temp = await mkdtemp(join(tmpdir(), "aw-move-eperm-"));
  const home = join(temp, "home");
  const hub = join(temp, "hub");
  await mkdir(home);
  await mkdir(join(hub, ".workflow", "sessions"), { recursive: true });
  await writeFile(join(hub, ".workflow", "workline.json"), '{"workline":1,"namespace":"workflow"}');
  const destination = join(temp, "new-hub");
  await expect(
    moveWorkspace(fs, new PathsService(normalizeNamespace("workflow"), home, hub), {
      destination,
      repair: false,
      dryRun: false,
      renameWorkspace: async () => {
        const error = new Error("ocupado") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      },
    }),
  ).rejects.toThrow(/EPERM.*cierra los procesos/);
  expect(await fs.exists(hub)).toBe(true);
  expect(await fs.exists(destination)).toBe(false);
});

it("se niega antes del rename cuando el destino cae dentro de otro hub o de una unidad", async () => {
  temp = await mkdtemp(join(tmpdir(), "aw-move-invalid-"));
  const home = join(temp, "home");
  const hub = join(temp, "hub");
  const other = join(temp, "otro-hub");
  await mkdir(home);
  for (const path of [hub, other]) {
    await mkdir(join(path, ".workflow", "sessions"), { recursive: true });
    await writeFile(
      join(path, ".workflow", "workline.json"),
      '{"workline":1,"namespace":"workflow"}',
    );
  }
  const paths = new PathsService(normalizeNamespace("workflow"), home, hub);
  for (const destination of [
    join(other, "hijo"),
    join(paths.userUnitsDir(), "ws", "src", "001", "nuevo"),
  ]) {
    await expect(
      moveWorkspace(fs, paths, { repair: false, destination, dryRun: true }),
    ).rejects.toThrow(/Destino de hub inválido|cae dentro del hub/);
    expect(await fs.exists(hub)).toBe(true);
  }
});

it("discard y reset resuelven sus sesiones desde la custodia reparada", async () => {
  temp = await mkdtemp(join(tmpdir(), "aw-move-retire-"));
  const home = join(temp, "home");
  const old = join(temp, "old");
  const next = join(temp, "next");
  await mkdir(home);
  await mkdir(join(old, ".workflow", "sessions"), { recursive: true });
  await writeFile(join(old, ".workflow", "workline.json"), '{"workline":1,"namespace":"workflow"}');
  const paths = new PathsService(normalizeNamespace("workflow"), home, old);
  const sessions = [];
  for (const name of ["uno-quick", "dos-quick"]) {
    const result = await runSessionCreate(fs, paths, { type: "quick", name, objetivo: name });
    if ("error" in result) throw Error(result.error);
    sessions.push(result.sessionCreate.number);
  }
  await rename(old, next);
  const relocated = new PathsService(paths.namespace, home, next);
  await moveWorkspace(fs, relocated, { repair: true, dryRun: false });
  const deps = {
    fs,
    env: new FakeEnv(home, next),
    git: new GitCliAdapter(new NodeProcess()),
    paths: relocated,
  };
  for (const [mode, code] of [
    ["discard", sessions[0]],
    ["reset", sessions[1]],
  ] as const) {
    const target = `session:${code}`;
    const prepared = await prepareRetirement(deps, { mode, target });
    if (!prepared.ok) throw Error(JSON.stringify(prepared.rejection));
    const applied = await applyRetirement(deps, {
      mode,
      target,
      approval: prepared.proposal.digest,
    });
    if (!applied.ok) throw Error(JSON.stringify(applied.rejection));
    expect(applied.result.already_applied).toBe(false);
  }
});
