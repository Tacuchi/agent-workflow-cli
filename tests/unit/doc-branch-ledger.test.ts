import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import {
  appendDocBranch,
  documentOfSession,
  readDocBranches,
  resolveDocBranch,
} from "../../src/application/doc-branch-ledger.js";
import { PathsService } from "../../src/application/paths-service.js";
import { sealCustody } from "../../src/domain/session/custody.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";

describe("ramas por documento y linaje", () => {
  const fs = new NodeFileSystem();
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function fixture() {
    const root = mkdtempSync(join(tmpdir(), "doc-branch-ledger-"));
    roots.push(root);
    const paths = new PathsService(normalizeNamespace("workflow"), root, root);
    mkdirSync(paths.cwdSessionsDir(), { recursive: true });
    mkdirSync(join(root, "docs", "plans"), { recursive: true });
    mkdirSync(join(root, "docs", "specs"), { recursive: true });
    const source = { alias: "core", path: root, main_branch: "main" };
    const block = {
      fuentes: [source],
      working_branches: { core: "main" },
      qa_branches: {},
      default_branches: {},
    };
    const spec = "docs/specs/049-spec-rama.md";
    writeFileSync(join(root, spec), "# Spec 049\n");
    for (const number of ["067", "068"]) {
      writeFileSync(
        join(root, "docs", "plans", `${number}-plan-rama.md`),
        `# Plan ${number}\n> Derived from ${spec}\n`,
      );
    }
    return { root, paths, source, block, spec };
  }

  it("gana el último evento y dos hermanos heredan salvo el que declara su propia rama", async () => {
    const { paths, source, block } = fixture();
    const event = (kind: "spec" | "plan", key: string, branch: string) =>
      appendDocBranch(fs, paths, {
        version: 1,
        at: new Date().toISOString(),
        doc: { kind, key },
        source: "core",
        branch,
        by: "test",
        outcome: "existing",
      });
    await event("spec", "049", "feature/spec-v1");
    await event("spec", "049", "feature/spec-v2");
    await event("plan", "068", "feature/plan-068");
    await fs.appendText(join(paths.cwdRoot(), "doc-branches.jsonl"), "{rota\n");
    const read = await readDocBranches(fs, paths);
    expect(read.unreadable).toBe(1);
    const withoutOwn = await resolveDocBranch(
      fs,
      paths,
      source,
      block as never,
      { status: "resolved", doc: { kind: "plan", key: "067" }, path: null },
      { events: [], unreadable: 0 },
    );
    expect(withoutOwn).toMatchObject({ branch: "main", origin: "registered" });
    expect(withoutOwn.reason).toBeUndefined();
    const first = await resolveDocBranch(
      fs,
      paths,
      source,
      block as never,
      { status: "resolved", doc: { kind: "plan", key: "067" }, path: null },
      read,
    );
    const second = await resolveDocBranch(
      fs,
      paths,
      source,
      block as never,
      { status: "resolved", doc: { kind: "plan", key: "068" }, path: null },
      read,
    );
    expect(first).toMatchObject({
      branch: "feature/spec-v2",
      origin: "inherited",
      inherited_from: "spec:049",
    });
    expect(second).toMatchObject({ branch: "feature/plan-068", origin: "own" });
    expect(
      (await resolveDocBranch(fs, paths, source, block as never, { status: "none" }, read)).origin,
    ).toBe("registered");
  });

  it("la custodia identifica al quick, distingue la sesión sin documento e informa la ilegible", async () => {
    const { paths } = fixture();
    const quick = "103-tarea-quick";
    const plain = "104-tarea-plan-exec";
    for (const session of [quick, plain]) {
      const dir = join(paths.cwdSessionsDir(), session);
      mkdirSync(dir);
      writeFileSync(
        join(dir, ".custody.json"),
        JSON.stringify(
          sealCustody({
            subject: { kind: "session", key: session },
            subjectPath: dir,
            created: "2026-09-27",
            parents: [],
          }),
        ),
      );
    }
    expect(await documentOfSession(fs, paths, quick)).toMatchObject({
      status: "resolved",
      doc: { kind: "quick", key: quick },
    });
    expect(await documentOfSession(fs, paths, plain)).toEqual({ status: "none" });
    writeFileSync(join(paths.cwdSessionsDir(), plain, ".custody.json"), "{bad");
    expect(await documentOfSession(fs, paths, plain)).toMatchObject({ status: "unreadable" });
  });
});
