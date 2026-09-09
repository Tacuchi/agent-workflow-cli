import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { prepareSkillChange } from "../../src/application/self/skills-change.js";
import { acquireSource } from "../../src/application/self/skills-discovery.js";
import { canonicalSkillsRoot } from "../../src/application/self/skills-manager.js";
import { readSkillsRegistry } from "../../src/application/self/skills-registry.js";
import type { CliContext } from "../../src/cli/types.js";
import { FakeEnv } from "../helpers/fake-env.js";

// Spec 043 · F2 — la preparación se ejercita de verdad: repositorios git
// locales con el layout que la investigación encontró (colección con raíz,
// plugins/<x>/skills/<x>), recursos compartidos, identidades repetidas y
// fallos. Ningún mock devuelve éxito por adelantado.

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

async function skillFile(dir: string, name: string, body = "body"): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: skill ${name}\n---\n${body}\n`,
    "utf8",
  );
}

async function commit(repo: string): Promise<void> {
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "test@test");
  git(repo, "config", "user.name", "test");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "v1");
}

describe("preparación de skills (Spec 043 · F2)", () => {
  let root: string;
  let home: string;
  let ctx: CliContext;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "aw-skill-prep-"));
    home = join(root, "home");
    await mkdir(home, { recursive: true });
    ctx = { fs: new NodeFileSystem(), env: new FakeEnv(home) } as unknown as CliContext;
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** Colección con skill raíz y hojas anidadas: el caso que hoy es inalcanzable. */
  async function collectionRepo(): Promise<string> {
    const repo = join(root, "collection");
    await skillFile(repo, "context-engineering-collection");
    for (const leaf of ["tool-design", "filesystem-context", "skill-template"]) {
      await skillFile(join(repo, "skills", leaf), leaf);
    }
    await commit(repo);
    return `file://${repo}`;
  }

  it("enumera la raíz Y las hojas anidadas, sin detenerse en la raíz ni deduplicar", async () => {
    const acquired = await acquireSource(await collectionRepo());
    if ("code" in acquired) throw new Error(acquired.message);
    try {
      expect(acquired.inventory.candidates.map((c) => c.path).sort()).toEqual([
        "",
        "skills/filesystem-context",
        "skills/skill-template",
        "skills/tool-design",
      ]);
      expect(acquired.inventory.resolvedRef).toMatch(/^[0-9a-f]{40}$/);
      expect(acquired.inventory.truncated).toBe(false);
    } finally {
      await acquired.release();
    }
  });

  it("alcanza plugins/<x>/skills/<x>, la profundidad del layout Trail of Bits", async () => {
    const repo = join(root, "trailofbits");
    for (const plugin of ["property-based-testing", "sharp-edges"]) {
      await skillFile(join(repo, "plugins", plugin, "skills", plugin), plugin);
    }
    await writeFile(join(repo, "LICENSE"), "CC-BY-SA-4.0 text", "utf8");
    await commit(repo);

    const prepared = await prepareSkillChange(ctx, {
      operation: "install",
      source: `file://${repo}`,
      paths: ["plugins/sharp-edges/skills/sharp-edges"],
    });
    if (prepared.status !== "prepared") throw new Error(`estado ${prepared.status}`);
    try {
      const skill = prepared.proposal.additions[0];
      expect(skill?.name).toBe("sharp-edges");
      expect(skill?.path).toBe("plugins/sharp-edges/skills/sharp-edges");
      // La licencia del ancestro viaja con la procedencia, sin afirmar cumplimiento.
      expect(skill?.provenance.licences.map((l) => l.from)).toEqual(["LICENSE"]);
      expect(skill?.files.map((f) => f.path)).toContain(
        "references/workline-provenance/PROVENANCE.md",
      );
      // Ninguna otra identidad operativa se cuela.
      expect(skill?.manifests.map((m) => m.name)).toEqual(["sharp-edges"]);
    } finally {
      await prepared.release();
    }
  });

  it("la raíz elegida NO arrastra sus hojas: quedan declaradas como excluidas", async () => {
    const prepared = await prepareSkillChange(ctx, {
      operation: "install",
      source: await collectionRepo(),
      paths: [""],
    });
    if (prepared.status !== "prepared") throw new Error(`estado ${prepared.status}`);
    try {
      const skill = prepared.proposal.additions[0];
      expect(skill?.manifests.map((m) => m.name)).toEqual(["context-engineering-collection"]);
      expect(skill?.files.map((f) => f.path)).not.toContain("skills/tool-design/SKILL.md");
      expect(skill?.provenance.notes.join(" ")).toContain("skills/tool-design");
    } finally {
      await prepared.release();
    }
  });

  it("prepara las siete hojas juntas sin ejemplos ni plantilla incidentales", async () => {
    const repo = join(root, "context");
    const leaves = [
      "tool-design",
      "filesystem-context",
      "context-compression",
      "context-optimization",
      "context-degradation",
      "evaluation",
      "harness-engineering",
    ];
    for (const leaf of [...leaves, "skill-template", "digital-brain"]) {
      await skillFile(join(repo, "skills", leaf), leaf);
    }
    await commit(repo);

    const prepared = await prepareSkillChange(ctx, {
      operation: "install",
      source: `file://${repo}`,
      paths: leaves.map((leaf) => `skills/${leaf}`),
    });
    if (prepared.status !== "prepared") throw new Error(`estado ${prepared.status}`);
    try {
      expect(prepared.proposal.additions.map((s) => s.name).sort()).toEqual([...leaves].sort());
      const materialized = prepared.proposal.additions.flatMap((s) =>
        s.manifests.map((m) => m.name),
      );
      expect(materialized).not.toContain("skill-template");
      expect(materialized).not.toContain("digital-brain");
      expect(materialized.sort()).toEqual([...leaves].sort());
    } finally {
      await prepared.release();
    }
  });

  it("dos skills con el mismo nombre son dos alternativas, no una elección al azar", async () => {
    const repo = join(root, "twins");
    await skillFile(join(repo, "a", "evaluation"), "evaluation");
    await skillFile(join(repo, "b", "evaluation"), "evaluation");
    await commit(repo);

    const outcome = await prepareSkillChange(ctx, {
      operation: "install",
      source: `file://${repo}`,
      pick: "evaluation",
    });
    if (outcome.status !== "needs-choice") throw new Error(`estado ${outcome.status}`);
    try {
      expect(outcome.candidates.map((c) => c.path).sort()).toEqual([
        "a/evaluation",
        "b/evaluation",
      ]);
    } finally {
      await outcome.release();
    }
  });

  it("directorio e identidad divergentes: el registro propuesto conserva las dos", async () => {
    const repo = join(root, "vercel");
    await skillFile(join(repo, "skills", "react-best-practices"), "vercel-react-best-practices");
    await commit(repo);

    const prepared = await prepareSkillChange(ctx, {
      operation: "install",
      source: `file://${repo}`,
      paths: ["skills/react-best-practices"],
    });
    if (prepared.status !== "prepared") throw new Error(`estado ${prepared.status}`);
    try {
      const skill = prepared.proposal.additions[0];
      expect(skill?.name).toBe("vercel-react-best-practices");
      expect(skill?.provenance.directory).toBe("react-best-practices");
      const entry = prepared.proposal.proposedRegistry["vercel-react-best-practices"];
      expect(entry?.skillName).toBe("vercel-react-best-practices");
      expect(entry?.path).toBe("skills/react-best-practices");
      expect(entry?.resolvedRef).toMatch(/^[0-9a-f]{40}$/);
      expect(entry?.payloadDigest).toBe(skill?.digest);
    } finally {
      await prepared.release();
    }
  });

  it("un recurso compartido fuera de la carpeta se importa identificado y se reenlaza", async () => {
    const repo = join(root, "shared");
    await skillFile(
      join(repo, "skills", "tool-design"),
      "tool-design",
      "Lee la [guía compartida](../../shared/GUIDE.md).",
    );
    await mkdir(join(repo, "shared"), { recursive: true });
    await writeFile(join(repo, "shared", "GUIDE.md"), "# Guía\n", "utf8");
    await commit(repo);

    const prepared = await prepareSkillChange(ctx, {
      operation: "install",
      source: `file://${repo}`,
      paths: ["skills/tool-design"],
    });
    if (prepared.status !== "prepared") throw new Error(`estado ${prepared.status}`);
    try {
      const skill = prepared.proposal.additions[0];
      expect(skill?.provenance.imported).toEqual([
        {
          from: "shared/GUIDE.md",
          to: "references/workline-imported/shared/GUIDE.md",
          digest: expect.any(String),
        },
      ]);
      expect(skill?.provenance.rewrites[0]?.from).toBe("../../shared/GUIDE.md");
      const manifest = await readFile(join(skill?.stagedAt ?? "", "SKILL.md"), "utf8");
      expect(manifest).toContain("references/workline-imported/shared/GUIDE.md");
      expect(manifest).not.toContain("../../shared/GUIDE.md");
    } finally {
      await prepared.release();
    }
  });

  it("una ruta citada dentro de un bloque de ejemplo no se vuelve dependencia", async () => {
    const repo = join(root, "fenced");
    await skillFile(
      join(repo, "skills", "evaluation"),
      "evaluation",
      "```md\nVer [esto](../../no-existe/X.md)\n```\n",
    );
    await commit(repo);

    const prepared = await prepareSkillChange(ctx, {
      operation: "install",
      source: `file://${repo}`,
      paths: ["skills/evaluation"],
    });
    if (prepared.status !== "prepared") throw new Error(`estado ${prepared.status}`);
    try {
      expect(prepared.proposal.additions[0]?.provenance.imported).toEqual([]);
    } finally {
      await prepared.release();
    }
  });

  it("si el recurso necesario pertenece a otra skill, la ampliación se exige y luego se prepara", async () => {
    const repo = join(root, "expansion");
    await skillFile(
      join(repo, "skills", "harness-engineering"),
      "harness-engineering",
      "Depende de [la otra](../evaluation/rules.md).",
    );
    await skillFile(join(repo, "skills", "evaluation"), "evaluation");
    await writeFile(join(repo, "skills", "evaluation", "rules.md"), "# Reglas\n", "utf8");
    await commit(repo);
    const source = `file://${repo}`;

    const needs = await prepareSkillChange(ctx, {
      operation: "install",
      source,
      paths: ["skills/harness-engineering"],
    });
    if (needs.status !== "needs-expansion") throw new Error(`estado ${needs.status}`);
    expect(needs.expansions[0]).toMatchObject({
      name: "evaluation",
      path: "skills/evaluation",
    });
    await needs.release();
    // Nada se instaló mientras la ampliación estaba pendiente.
    expect(existsSync(canonicalSkillsRoot(home))).toBe(false);

    const prepared = await prepareSkillChange(ctx, {
      operation: "install",
      source,
      paths: ["skills/harness-engineering", "skills/evaluation"],
    });
    if (prepared.status !== "prepared") throw new Error(`estado ${prepared.status}`);
    try {
      expect(prepared.proposal.additions.map((s) => s.name).sort()).toEqual([
        "evaluation",
        "harness-engineering",
      ]);
    } finally {
      await prepared.release();
    }
  });

  it("un recurso que se sale del origen o es un enlace se rechaza sin preparar nada", async () => {
    const escaping = join(root, "escaping");
    await skillFile(
      join(escaping, "skills", "tool-design"),
      "tool-design",
      "Necesita [algo de afuera](../../../../etc/hosts).",
    );
    await commit(escaping);
    const outside = await prepareSkillChange(ctx, {
      operation: "install",
      source: `file://${escaping}`,
      paths: ["skills/tool-design"],
    });
    expect(outside.status).toBe("rejected");
    if (outside.status === "rejected") {
      expect(outside.rejection.code).toBe("RESOURCE_OUTSIDE_SOURCE");
    }

    const linked = join(root, "linked");
    await skillFile(
      join(linked, "skills", "tool-design"),
      "tool-design",
      "Necesita [un enlace](../../shared/LINK.md).",
    );
    await mkdir(join(linked, "shared"), { recursive: true });
    await writeFile(join(linked, "real.md"), "# real\n", "utf8");
    await symlink(join(linked, "real.md"), join(linked, "shared", "LINK.md"));
    await commit(linked);
    const link = await prepareSkillChange(ctx, {
      operation: "install",
      source: `file://${linked}`,
      paths: ["skills/tool-design"],
    });
    // El clon materializa el enlace como enlace: se rechaza en vez de seguirlo.
    expect(link.status).toBe("rejected");
  });

  it("una referencia que no resuelve impide la propuesta, no se ignora", async () => {
    const repo = join(root, "dangling");
    await skillFile(
      join(repo, "skills", "evaluation"),
      "evaluation",
      "Ver [la nota](../../notes/MISSING.md).",
    );
    await commit(repo);
    const outcome = await prepareSkillChange(ctx, {
      operation: "install",
      source: `file://${repo}`,
      paths: ["skills/evaluation"],
    });
    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") expect(outcome.rejection.code).toBe("RESOURCE_UNRESOLVED");
  });

  it("un clon fallido devuelve su motivo y no toca el registro", async () => {
    const outcome = await prepareSkillChange(ctx, {
      operation: "install",
      source: `file://${join(root, "no-existe")}`,
    });
    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") expect(outcome.rejection.code).toBe("GIT_CLONE_FAILED");
    const { registry } = await readSkillsRegistry(ctx);
    expect(registry.skills).toEqual({});
  });

  it("si el contenido del origen cambia después de la preview, el sello cambia", async () => {
    const repo = join(root, "moving");
    await skillFile(join(repo, "skills", "evaluation"), "evaluation", "v1");
    await commit(repo);
    const source = `file://${repo}`;

    const first = await prepareSkillChange(ctx, {
      operation: "install",
      source,
      paths: ["skills/evaluation"],
    });
    if (first.status !== "prepared") throw new Error(`estado ${first.status}`);
    const before = first.proposal.digest;
    await first.release();

    await skillFile(join(repo, "skills", "evaluation"), "evaluation", "v2 — otro cuerpo");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "v2");

    const second = await prepareSkillChange(ctx, {
      operation: "install",
      source,
      paths: ["skills/evaluation"],
    });
    if (second.status !== "prepared") throw new Error(`estado ${second.status}`);
    try {
      expect(second.proposal.digest).not.toBe(before);
    } finally {
      await second.release();
    }
  });

  it("una sustitución enumera las altas y el retiro en la MISMA propuesta", async () => {
    // Instalación previa administrada de la colección completa.
    const legacy = join(root, "legacy-collection");
    await skillFile(legacy, "context-engineering-collection");
    await commit(legacy);
    const registered = await prepareSkillChange(ctx, {
      operation: "install",
      source: `file://${legacy}`,
      paths: [""],
    });
    if (registered.status !== "prepared") throw new Error("no preparó la colección");
    await registered.release();
    // El registro se escribe recién en F3: se simula la instalación previa.
    await mkdir(join(home, ".agents"), { recursive: true });
    await writeFile(
      join(home, ".agents", ".skills-registry.json"),
      JSON.stringify({
        skills: {
          "context-engineering-collection": {
            source: `file://${legacy}`,
            installedAt: "2026-01-01T00:00:00.000Z",
            mode: "symlink",
          },
        },
      }),
      "utf8",
    );
    await skillFile(
      join(canonicalSkillsRoot(home), "context-engineering-collection"),
      "context-engineering-collection",
    );

    const repo = join(root, "leaves");
    for (const leaf of ["tool-design", "evaluation"]) {
      await skillFile(join(repo, "skills", leaf), leaf);
    }
    await commit(repo);

    const prepared = await prepareSkillChange(ctx, {
      operation: "replace",
      source: `file://${repo}`,
      paths: ["skills/tool-design", "skills/evaluation"],
      withdraw: ["context-engineering-collection"],
    });
    if (prepared.status !== "prepared") throw new Error(`estado ${prepared.status}`);
    try {
      expect(prepared.proposal.additions.map((s) => s.name).sort()).toEqual([
        "evaluation",
        "tool-design",
      ]);
      expect(prepared.proposal.withdrawals).toEqual(["context-engineering-collection"]);
      expect(prepared.proposal.proposedRegistry["context-engineering-collection"]).toBeNull();
      const deletes = prepared.proposal.destinations.filter((d) => d.action === "delete");
      expect(deletes.map((d) => d.host).sort()).toEqual(["agents", "claude", "gemini"]);
      expect(prepared.proposal.effects).toContain("destructive");
    } finally {
      await prepared.release();
    }
  });

  it("registrar declara su único efecto y no propone destinos de instalación", async () => {
    const repo = join(root, "register-only");
    await skillFile(join(repo, "skills", "prometheus"), "prometheus");
    await commit(repo);

    const prepared = await prepareSkillChange(ctx, {
      operation: "register",
      source: `file://${repo}`,
      paths: ["skills/prometheus"],
    });
    if (prepared.status !== "prepared") throw new Error(`estado ${prepared.status}`);
    try {
      expect(prepared.proposal.effects).toEqual(["local_additive"]);
      expect(prepared.proposal.destinations.map((d) => d.host)).toEqual(["registry"]);
      expect(prepared.proposal.proposedRegistry.prometheus?.installedAt).toBeUndefined();
      expect(prepared.proposal.notes.join(" ")).toContain("Registrar no instala");
    } finally {
      await prepared.release();
    }
  });

  it("una carpeta local se recorre con límites declarados y una ruta explícita siempre entra", async () => {
    const dir = join(root, "local-source");
    await skillFile(join(dir, "skills", "tool-design"), "tool-design");
    await mkdir(join(dir, "node_modules", "x"), { recursive: true });
    await skillFile(join(dir, "node_modules", "x"), "no-deberia-verse");
    const acquired = await acquireSource(dir);
    if ("code" in acquired) throw new Error(acquired.message);
    try {
      expect(acquired.inventory.kind).toBe("local");
      expect(acquired.inventory.resolvedRef).toBeNull();
      expect(acquired.inventory.limits).toEqual({ maxDepth: 6, maxEntries: 5000 });
      expect(acquired.inventory.candidates.map((c) => c.name)).toEqual(["tool-design"]);
    } finally {
      await acquired.release();
    }
  });

  it("una operación sin fuente sobre un nombre no registrado rehúsa con el guard de propiedad", async () => {
    for (const operation of ["repair", "uninstall", "remove"] as const) {
      const outcome = await prepareSkillChange(ctx, { operation, name: "w" });
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") {
        expect(outcome.rejection.code).toBe("SKILL_NOT_REGISTERED");
      }
    }
  });

  it("una referencia transitiva se resuelve desde el ORIGEN del documento importado", async () => {
    const repo = join(root, "transitive");
    await skillFile(
      join(repo, "skills", "tool-design"),
      "tool-design",
      "Ver la [guía](../../shared/A.md).",
    );
    await mkdir(join(repo, "shared"), { recursive: true });
    await writeFile(join(repo, "shared", "A.md"), "Sigue en [B](./B.md).\n", "utf8");
    await writeFile(join(repo, "shared", "B.md"), "# B\n", "utf8");
    await commit(repo);

    const prepared = await prepareSkillChange(ctx, {
      operation: "install",
      source: `file://${repo}`,
      paths: ["skills/tool-design"],
    });
    if (prepared.status !== "prepared") throw new Error(`estado ${prepared.status}`);
    try {
      const skill = prepared.proposal.additions[0];
      // B llega porque el enlace de A se resolvió donde A fue escrito, no
      // donde quedó copiado.
      expect(skill?.provenance.imported.map((i) => i.from).sort()).toEqual([
        "shared/A.md",
        "shared/B.md",
      ]);
      const importedA = await readFile(
        join(skill?.stagedAt ?? "", "references/workline-imported/shared/A.md"),
        "utf8",
      );
      expect(importedA).toContain("B.md");
    } finally {
      await prepared.release();
    }
  });

  it("la misma ruta dentro de un bloque de ejemplo NO se reescribe", async () => {
    const repo = join(root, "fenced-rewrite");
    await skillFile(
      join(repo, "skills", "evaluation"),
      "evaluation",
      "Real: [guía](../../shared/GUIDE.md).\n\n```md\n[guía](../../shared/GUIDE.md)\n```\n",
    );
    await mkdir(join(repo, "shared"), { recursive: true });
    await writeFile(join(repo, "shared", "GUIDE.md"), "# Guía\n", "utf8");
    await commit(repo);

    const prepared = await prepareSkillChange(ctx, {
      operation: "install",
      source: `file://${repo}`,
      paths: ["skills/evaluation"],
    });
    if (prepared.status !== "prepared") throw new Error(`estado ${prepared.status}`);
    try {
      const manifest = await readFile(
        join(prepared.proposal.additions[0]?.stagedAt ?? "", "SKILL.md"),
        "utf8",
      );
      expect(manifest).toContain("Real: [guía](references/workline-imported/shared/GUIDE.md)");
      // El ejemplo queda tal cual: documentar una ruta no es depender de ella.
      expect(manifest).toContain("```md\n[guía](../../shared/GUIDE.md)\n```");
    } finally {
      await prepared.release();
    }
  });

  it("un payload que no se pudo recorrer completo se rechaza en vez de instalarse a medias", async () => {
    const dir = join(root, "unreadable-source");
    await skillFile(join(dir, "skills", "tool-design"), "tool-design");
    const blocked = join(dir, "skills", "tool-design", "references");
    await mkdir(blocked, { recursive: true });
    await writeFile(join(blocked, "keep.md"), "# keep\n", "utf8");
    // Un directorio ilegible: el recorrido se corta y la preparación rehúsa.
    await chmod(blocked, 0o000);
    try {
      const outcome = await prepareSkillChange(ctx, {
        operation: "install",
        source: dir,
        paths: ["skills/tool-design"],
      });
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") {
        expect(outcome.rejection.code).toBe("PAYLOAD_TRUNCATED");
      }
    } finally {
      await chmod(blocked, 0o755);
    }
  });
});
