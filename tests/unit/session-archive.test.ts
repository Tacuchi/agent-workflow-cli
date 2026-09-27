import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { PathsService } from "../../src/application/paths-service.js";
import { runSessionClose } from "../../src/application/session-close-service.js";
import { runSessionCreate } from "../../src/application/session-create-service.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";

describe("mínimo durable de una sesión", () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  it("copia SQL, rollback, evidencia consentida y sustituye el snapshot al re-cerrar", async () => {
    const root = await mkdtemp(join(tmpdir(), "aw-minimum-"));
    roots.push(root);
    const fs = new NodeFileSystem();
    const paths = new PathsService(normalizeNamespace("workflow"), root, root);
    const created = await runSessionCreate(fs, paths, {
      type: "quick",
      name: "durable-quick",
      objetivo: "guardar el trabajo",
    });
    if ("error" in created) throw new Error(created.error);
    const { folder, path } = created.sessionCreate;
    const scratch = join(root, "scratch.sql");
    const external = await mkdtemp(join(tmpdir(), "aw-cited-"));
    roots.push(external);
    const cited = join(external, "evidencia.txt");
    await writeFile(cited, Buffer.from([0, 255, 3]));
    await fs.writeText(join(path, "CHECKPOINT.md"), "# CHECKPOINT\n\n## Completed\nhecho\n");
    await fs.writeText(join(path, "DECISION.md"), "# DECISION\naceptada\n");
    await fs.writeText(join(path, "BACKLOG.md"), `# BACKLOG\n\nReferencia: \`${cited}\`\n`);
    await fs.writeText(join(path, "CONCLUSIONS.md"), `# CONCLUSIONS\n\n\`${scratch}\`\n`);
    await fs.writeText(join(path, "SCRIPTS.sql"), "select 1;\n");
    await fs.writeText(join(path, "ROLLBACK.sql"), "select 2;\n");
    await fs.mkdirp(join(path, "scripts"));
    await fs.writeText(join(path, "scripts", "paso.sql"), "select 3;\n");
    await fs.writeText(
      join(path, "SESSION.md"),
      "# SESSION\n\n## Objective\nguardar\n\n## Origin\n- pedido\n\n## Success criteria\n- [x] guardado\n",
    );
    const listed = await runSessionClose(fs, paths, { code: folder });
    if (!("sessionClose" in listed)) throw new Error(JSON.stringify(listed));
    expect(listed.sessionClose.scratch_references).toContain(cited);
    expect(listed.sessionClose.evidence_copied).toBeUndefined();
    const closed = await runSessionClose(fs, paths, { code: folder, withEvidence: true });
    if (!("sessionClose" in closed)) throw new Error(JSON.stringify(closed));
    expect(closed.sessionClose.archive_error).toBeUndefined();
    expect(closed.sessionClose.scratch_references).toContain(cited);
    expect(closed.sessionClose.evidence_copied).toHaveLength(1);
    const archive = join(root, ".workflow", "archive", folder);
    for (const file of [
      "CHECKPOINT.md",
      "DECISION.md",
      "BACKLOG.md",
      "SCRIPTS.sql",
      "ROLLBACK.sql",
      "scripts/paso.sql",
    ])
      expect(await fs.exists(join(archive, file))).toBe(true);
    const evidence = closed.sessionClose.evidence_copied?.[0];
    if (!evidence) throw new Error("faltó la evidencia");
    expect(Buffer.from(await fs.readBytes(join(archive, evidence)))).toEqual(
      Buffer.from([0, 255, 3]),
    );
    await fs.remove(join(path, "SCRIPTS.sql"));
    const again = await runSessionClose(fs, paths, { code: folder });
    expect(again).toHaveProperty("sessionClose.closed", true);
    expect(await fs.exists(join(archive, "SCRIPTS.sql"))).toBe(false);
    expect(await readFile(join(archive, "DECISION.md"), "utf8")).toContain("aceptada");
  });
});
