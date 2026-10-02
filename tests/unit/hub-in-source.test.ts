import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

let root: string | null = null;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});
const cli = fileURLToPath(new URL("../../dist/cli/main.js", import.meta.url));

it("persist apply desde el checkout resuelve el único hub incluso con marcador en HOME", () => {
  root = mkdtempSync(join(tmpdir(), "aw-source-cwd-"));
  const home = join(root, "home");
  const hub = join(root, "hub");
  const source = join(root, "source");
  for (const dir of [home, hub, source]) mkdirSync(dir);
  mkdirSync(join(home, ".workflow"));
  writeFileSync(join(home, ".workflow", "workline.json"), '{"workline":1,"namespace":"workflow"}');
  mkdirSync(join(hub, ".workflow", "sessions"), { recursive: true });
  writeFileSync(join(hub, ".workflow", "workline.json"), '{"workline":1,"namespace":"workflow"}');
  writeFileSync(
    join(hub, "AGENTS.md"),
    `<!-- WORKFLOW-HUB-START -->\n## Fuentes\n| Alias | Path | Rama principal |\n|---|---|---|\n| src | ${source} | main |\n<!-- WORKFLOW-HUB-END -->`,
  );
  spawnSync("git", ["init", "-q", source]);
  const run = (cwd: string, args: string[], input?: string) => {
    const output = spawnSync(process.execPath, [cli, ...args, "--json"], {
      cwd,
      env: { ...process.env, HOME: home, AW_NAMESPACE: "workflow" },
      encoding: "utf8",
      input,
    });
    return {
      status: output.status,
      body: JSON.parse(output.stdout) as Record<string, unknown>,
      error: output.stderr,
    };
  };
  expect(run(hub, ["status"]).status).toBe(0); // reads the hub without writing in source
  // A hub under the system temp folder is never registered implicitly (plan 088).
  expect(run(home, ["hubs", "scan", hub, "--apply"]).status).toBe(0);
  const prepared = run(hub, ["persist", "prepare"]);
  expect(prepared.status).toBe(0);
  const request = prepared.body.request as { input_digest: string };
  const answer = JSON.stringify({
    version: 1,
    operation: "persist",
    input_digest: request.input_digest,
    state: "proposed",
    decisions: { category: "research", slug: "desde-fuente", mode: "new" },
    artifacts: [
      { path: "docs/research/001-research-desde-fuente.md", content: "# Prueba\n\nreal\n" },
    ],
  });
  const validated = run(hub, ["persist", "validate"], answer);
  expect(validated.status).toBe(0);
  const applied = run(
    source,
    ["persist", "apply", "--approval", validated.body.approval_digest as string],
    answer,
  );
  expect(applied.status).toBe(0);
  expect(readdirSync(join(hub, "docs", "research"))).toContain("001-research-desde-fuente.md");
  expect(readdirSync(source)).not.toContain(".workflow");
  expect(readdirSync(source)).not.toContain(".gitignore");
});

it("un repo sin hub con marcador en HOME no funda runtime ni edita .gitignore", () => {
  root = mkdtempSync(join(tmpdir(), "aw-unclaimed-"));
  const home = join(root, "home");
  const repo = join(root, "repo");
  mkdirSync(join(home, ".workflow"), { recursive: true });
  mkdirSync(repo);
  writeFileSync(join(home, ".workflow", "workline.json"), '{"workline":1,"namespace":"workflow"}');
  spawnSync("git", ["init", "-q", repo]);
  const result = spawnSync(
    process.execPath,
    [
      cli,
      "session-create",
      "--type",
      "quick",
      "--name",
      "sin-hub",
      "--objetivo",
      "probar",
      "--json",
    ],
    {
      cwd: repo,
      env: { ...process.env, HOME: home, AW_NAMESPACE: "workflow" },
      encoding: "utf8",
    },
  );
  expect(result.status).not.toBe(0);
  expect(result.stdout + result.stderr).toContain("HUB_UNRESOLVED");
  expect(readdirSync(repo)).not.toContain(".workflow");
  expect(readdirSync(repo)).not.toContain(".gitignore");
});

it("context-budget mide el bundle desde un checkout sin hub ni --workspace", () => {
  root = mkdtempSync(join(tmpdir(), "aw-budget-no-hub-"));
  const home = join(root, "home");
  const repo = join(root, "repo");
  mkdirSync(home);
  mkdirSync(repo);
  spawnSync("git", ["init", "-q", repo]);
  const checkout = fileURLToPath(new URL("../../", import.meta.url));
  const result = spawnSync(
    process.execPath,
    [
      cli,
      "context-budget",
      "--root",
      join(checkout, "skills", "w"),
      "--baseline",
      join(checkout, "tests", "fixtures", "context-baseline.json"),
      "--json",
    ],
    { cwd: repo, env: { ...process.env, HOME: home, AW_NAMESPACE: "workflow" }, encoding: "utf8" },
  );
  expect(result.status, result.stderr || result.stdout).toBe(0);
  const body = JSON.parse(result.stdout);
  expect(body.verdict).toBe("ok");
  expect(body.offenders).toEqual([]);
  expect(readdirSync(repo)).not.toContain(".workflow");
});

describe("plan 088 F5 · la guarda de materialización reclama por contención", () => {
  function tree() {
    root = realpathSync(mkdtempSync(join(tmpdir(), "aw-claim-")));
    const home = join(root, "home");
    mkdirSync(join(home, ".workflow"), { recursive: true });
    const legacyHub = (path: string) => {
      mkdirSync(join(path, ".workflow", "sessions"), { recursive: true });
      writeFileSync(join(path, ".workflow", "HISTORY.md"), "# Session History\n");
      return path;
    };
    const hubDeclaring = (path: string, alias: string, source: string) => {
      mkdirSync(join(path, ".workflow", "sessions"), { recursive: true });
      writeFileSync(
        join(path, ".workflow", "workline.json"),
        '{"workline":1,"namespace":"workflow"}',
      );
      writeFileSync(
        join(path, "AGENTS.md"),
        `<!-- WORKFLOW-HUB-START -->\n## Fuentes\n| Alias | Path | Rama principal |\n|---|---|---|\n| ${alias} | ${source} | main |\n<!-- WORKFLOW-HUB-END -->`,
      );
      return path;
    };
    const register = (...hubs: string[]) =>
      writeFileSync(
        join(home, ".workflow", "hubs.json"),
        JSON.stringify({ version: 1, roots: hubs }),
      );
    const migrate = (hub: string) => {
      const output = spawnSync(
        process.execPath,
        [cli, "hub-migrate", "--hub", hub, "--apply", "--json"],
        {
          cwd: root ?? "",
          env: { ...process.env, HOME: home, USERPROFILE: home, AW_NAMESPACE: "workflow" },
          encoding: "utf8",
        },
      );
      return {
        status: output.status,
        body: JSON.parse(output.stdout) as { error?: { code: string } },
      };
    };
    const init = (cwd: string, ...args: string[]) => {
      const output = spawnSync(process.execPath, [cli, "hub-init", ...args, "--json"], {
        cwd,
        env: { ...process.env, HOME: home, USERPROFILE: home, AW_NAMESPACE: "workflow" },
        encoding: "utf8",
      });
      return { status: output.status, text: output.stdout + output.stderr };
    };
    return { root, legacyHub, hubDeclaring, register, migrate, init };
  }

  it("un hub hermano del repo se materializa aunque otro hub declare su propia carpeta como fuente '.'", () => {
    const { root: base, legacyHub, hubDeclaring, register, migrate } = tree();
    const repo = join(base, "monorepo");
    mkdirSync(join(repo, "projects"), { recursive: true });
    spawnSync("git", ["init", "-q", repo]);
    const alfa = hubDeclaring(join(repo, "projects", "alfa"), "alfa", ".");
    const beta = legacyHub(join(repo, "projects", "beta"));
    register(alfa);
    const migrated = migrate(beta);
    expect(migrated.status, JSON.stringify(migrated.body)).toBe(0);
    expect(existsSync(join(beta, ".workflow", "workline.json"))).toBe(true);
  });

  it("dentro de una fuente declarada entera, y en un worktree suyo, rechaza con HUB_IN_SOURCE", () => {
    const { root: base, legacyHub, hubDeclaring, register, migrate } = tree();
    const repo = join(base, "repo");
    spawnSync("git", ["init", "-q", repo]);
    spawnSync("git", [
      "-C",
      repo,
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "i",
    ]);
    spawnSync("git", ["-C", repo, "worktree", "add", "-q", join(base, "wt")]);
    register(hubDeclaring(join(base, "hub"), "src", repo));
    for (const candidate of [legacyHub(join(repo, "dentro")), legacyHub(join(base, "wt"))]) {
      const refused = migrate(candidate);
      expect(refused.status).not.toBe(0);
      expect(refused.body.error?.code).toBe("HUB_IN_SOURCE");
      expect(existsSync(join(candidate, ".workflow", "workline.json"))).toBe(false);
    }
  });

  it("en un worktree donde el hub que se declara '.' no tiene marcador, su contenedor se reclama", () => {
    const { root: base, hubDeclaring, register, init } = tree();
    const mono = join(base, "mono");
    mkdirSync(join(mono, "projects"), { recursive: true });
    spawnSync("git", ["init", "-q", mono]);
    spawnSync("git", [
      "-C",
      mono,
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "i",
    ]);
    spawnSync("git", ["-C", mono, "worktree", "add", "-q", join(base, "wt")]);
    register(hubDeclaring(join(mono, "projects", "alfa"), "alfa", "."));
    const refused = init(join(base, "wt"));
    expect(refused.text).toContain("HUB_IN_SOURCE");
    expect(existsSync(join(base, "wt", ".workflow"))).toBe(false);
  });

  // Revisión puntual del lote F5-F7: una fuente que es una subcarpeta del repo.
  describe("con la fuente declarada como subcarpeta de un monorepo", () => {
    function monorepo() {
      const built = tree();
      const mono = join(built.root, "mono");
      mkdirSync(join(mono, "svc"), { recursive: true });
      mkdirSync(join(mono, "hermano"), { recursive: true });
      spawnSync("git", ["init", "-q", mono]);
      spawnSync("git", [
        "-C",
        mono,
        "-c",
        "user.email=t@t",
        "-c",
        "user.name=t",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "i",
      ]);
      spawnSync("git", ["-C", mono, "worktree", "add", "-q", join(built.root, "wt")]);
      mkdirSync(join(built.root, "wt", "svc"), { recursive: true });
      built.register(built.hubDeclaring(join(built.root, "h2"), "svc", join(mono, "svc")));
      return { ...built, mono };
    }

    it("una carpeta que todavía no existe, nombrada por un symlink, se juzga donde cae", () => {
      const { root: base, mono, init } = monorepo();
      symlinkSync(mono, join(base, "link"));
      const target = join(base, "link", "svc", "nuevo");
      const refused = init(base, "--hub", target);
      expect(refused.status, refused.text).not.toBe(0);
      expect(refused.text).toContain("HUB_IN_SOURCE");
      expect(existsSync(join(mono, "svc", "nuevo", ".workflow"))).toBe(false);
    });

    it("un symlink a la subcarpeta fuente, con o sin una cola que todavía no existe, se reclama", () => {
      const { root: base, mono, init } = monorepo();
      symlinkSync(join(mono, "svc"), join(base, "linksvc"));
      for (const target of [join(base, "linksvc"), join(base, "linksvc", "nuevo")]) {
        const refused = init(base, "--hub", target);
        expect(refused.text, target).toContain("HUB_IN_SOURCE");
      }
      expect(existsSync(join(mono, "svc", ".workflow"))).toBe(false);
      expect(existsSync(join(mono, "svc", "nuevo"))).toBe(false);
    });

    it("la copia de la fuente en un worktree enlazado sigue reclamada", () => {
      const { root: base, init } = monorepo();
      const refused = init(join(base, "wt", "svc"));
      expect(refused.text).toContain("HUB_IN_SOURCE");
      expect(existsSync(join(base, "wt", "svc", ".workflow"))).toBe(false);
    });

    it("una carpeta que contiene la fuente no se funda, y un hermano sí", () => {
      const { mono, init } = monorepo();
      const refused = init(mono);
      expect(refused.text).toContain("HUB_IN_SOURCE");
      expect(existsSync(join(mono, ".workflow"))).toBe(false);
      const sibling = init(join(mono, "hermano"));
      expect(sibling.status, sibling.text).toBe(0);
      expect(existsSync(join(mono, "hermano", ".workflow", "workline.json"))).toBe(true);
    });
  });
});
