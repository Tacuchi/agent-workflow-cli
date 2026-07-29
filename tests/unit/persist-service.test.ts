import { describe, expect, it } from "vitest";
import { PathsService } from "../../src/application/paths-service.js";
import {
  applyPersist,
  preparePersist,
  validatePersist,
} from "../../src/application/persist-service.js";
import type { SemanticRequest } from "../../src/application/semantic-operation/protocol.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { MemFs } from "../helpers/mem-fs.js";

const env = new FakeEnv("/home", "/cwd");
const paths = (): PathsService => new PathsService(normalizeNamespace("workflow"), "/home", "/cwd");

function workspace(): MemFs {
  const fs = new MemFs();
  fs.file("/cwd/.workflow/sessions/.keep", "");
  return fs;
}

/** A well-formed answer, then mutate one field per test. */
function answer(request: SemanticRequest, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    operation: "persist",
    input_digest: request.input_digest,
    state: "proposed",
    decisions: { category: "research", slug: "comparar-motores", mode: "new" },
    artifacts: [
      { path: "docs/research/001-research-comparar-motores.md", content: "# Análisis\n\nok\n" },
    ],
    ...over,
  });
}

async function prepared(fs: MemFs): Promise<SemanticRequest> {
  return await preparePersist(fs, env, paths());
}

// ── prepare ──────────────────────────────────────────────────────────────────

describe("preparePersist — inventories without touching a byte", () => {
  it("writes nothing", async () => {
    const fs = workspace();
    fs.file("/cwd/docs/specs/003-spec-x.md", "# Spec\n\n## Origin\n\nvenía de una charla\n");
    await prepared(fs);
    expect([...fs.writes.keys()]).toEqual([]);
  });

  it("declares the three destinations, the consultative number and the read-set", async () => {
    const fs = workspace();
    fs.file("/cwd/docs/research/001-research-a.md", "# A\n\n## Objective\nprimera\n");
    fs.file("/cwd/docs/research/002-research-b.md", "# B\n\n## Objective\nsegunda\n");
    const request = await prepared(fs);

    expect(request.allowed_destinations).toEqual(["docs/research", "docs/specs", "docs/plans"]);
    expect(request.limits.max_artifacts).toBe(1);
    expect(request.read_set).toEqual([
      "docs/research/001-research-a.md",
      "docs/research/002-research-b.md",
    ]);
    expect(request.metrics.request_bytes).toBeGreaterThan(0);
  });

  it("exposes existing docs with a digest so a replacement can prove it saw them", async () => {
    const fs = workspace();
    fs.file("/cwd/docs/research/001-research-a.md", "# A\n\n## Objective\ncomparar motores\n");
    const request = await prepared(fs);
    const docs = (request.inventory as { categories: Record<string, { docs: unknown[] }> })
      .categories.research.docs as Array<{ summary: string; digest: string }>;
    expect(docs[0]?.summary).toBe("comparar motores");
    expect(docs[0]?.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the digest changes when docs/ changes — that is the whole staleness signal", async () => {
    const fs = workspace();
    const before = await prepared(fs);
    fs.file("/cwd/docs/specs/009-spec-nueva.md", "# Nueva\n");
    const after = await prepared(fs);
    expect(after.input_digest).not.toBe(before.input_digest);
  });
});

// ── validate ─────────────────────────────────────────────────────────────────

describe("validatePersist — fails closed, and always says what to do next", () => {
  it("accepts a well-formed proposal and returns a stable approval digest", async () => {
    const fs = workspace();
    const request = await prepared(fs);
    const first = validatePersist(answer(request), request);
    const second = validatePersist(answer(request), request);
    if (!first.ok || !second.ok) throw new Error("expected both to validate");
    expect(first.value.approval_digest).toBe(second.value.approval_digest);
    expect(first.value.preview).toMatchObject({ category: "research", mode: "new", target: null });
  });

  const rejections: Array<[string, Record<string, unknown> | string, string]> = [
    ["stdin vacío", "", "SEMANTIC_RESPONSE_MISSING"],
    ["JSON truncado", '{"version":1,"operation":"per', "SEMANTIC_RESPONSE_INVALID"],
    ["versión desconocida", { version: 99 }, "SEMANTIC_RESPONSE_INVALID"],
    ["otra operación", { operation: "export-manuals" }, "SEMANTIC_RESPONSE_INVALID"],
    ["digest de otro estado", { input_digest: "f".repeat(64) }, "SEMANTIC_STALE"],
    ["estado inventado", { state: "maybe" }, "SEMANTIC_RESPONSE_INVALID"],
    ["sin artefactos", { artifacts: [] }, "SEMANTIC_RESPONSE_INVALID"],
    [
      "categoría inventada",
      { decisions: { category: "notas", slug: "x", mode: "new" } },
      "SEMANTIC_RESPONSE_INVALID",
    ],
    [
      "slug no kebab",
      { decisions: { category: "research", slug: "Mi Slug", mode: "new" } },
      "SEMANTIC_RESPONSE_INVALID",
    ],
  ];

  it.each(rejections)("rechaza %s", async (_name, over, code) => {
    const fs = workspace();
    const request = await prepared(fs);
    const raw = typeof over === "string" ? over : answer(request, over);
    const result = validatePersist(raw, request);
    if (result.ok) throw new Error("expected a rejection");
    expect(result.failure.code).toBe(code);
    expect(result.failure.action.length).toBeGreaterThan(0);
  });

  // The write boundary: an allowlist checked on segments, not on a prefix.
  const escapes = [
    "docs/research/../../etc/passwd.md",
    "/etc/passwd.md",
    "docs/research-evil/001-research-x.md",
    "docs\\research\\001-research-x.md",
    "docs/sessions/001-research-x.md",
  ];

  it.each(escapes)("rechaza el destino '%s'", async (path) => {
    const fs = workspace();
    const request = await prepared(fs);
    const result = validatePersist(
      answer(request, { artifacts: [{ path, content: "x" }] }),
      request,
    );
    if (result.ok) throw new Error(`expected '${path}' to be rejected`);
    expect(result.failure.code).toBe("SEMANTIC_PATH_REJECTED");
  });

  it("rechaza un artefacto que excede el límite de bytes", async () => {
    const fs = workspace();
    const request = await prepared(fs);
    const result = validatePersist(
      answer(request, {
        artifacts: [
          {
            path: "docs/research/001-research-comparar-motores.md",
            content: "x".repeat(request.limits.max_artifact_bytes + 1),
          },
        ],
      }),
      request,
    );
    if (result.ok) throw new Error("expected a rejection");
    expect(result.failure.message).toContain("máximo");
  });

  it("rechaza un nombre de archivo que no respeta el esquema de la categoría", async () => {
    const fs = workspace();
    const request = await prepared(fs);
    const result = validatePersist(
      answer(request, {
        artifacts: [{ path: "docs/research/notas-sueltas.md", content: "x" }],
      }),
      request,
    );
    if (result.ok) throw new Error("expected a rejection");
    expect(result.failure.message).toContain("NNN-research-comparar-motores.md");
  });

  it("devuelve la ambigüedad como problema, no como escritura", async () => {
    const fs = workspace();
    const request = await prepared(fs);
    const result = validatePersist(
      answer(request, { state: "ambiguous", reason: "ya existe algo casi igual" }),
      request,
    );
    if (result.ok) throw new Error("expected a rejection");
    expect(result.failure.code).toBe("SEMANTIC_AMBIGUOUS");
    expect(result.failure.message).toContain("casi igual");
  });
});

describe("validatePersist — replacing an existing document needs proof", () => {
  function withDoc(): MemFs {
    const fs = workspace();
    fs.file("/cwd/docs/research/001-research-comparar-motores.md", "# A\n\n## Objective\nviejo\n");
    return fs;
  }

  const UPDATE = {
    category: "research",
    slug: "comparar-motores",
    mode: "update",
    target: "docs/research/001-research-comparar-motores.md",
  };

  it("acepta un update que prueba haber visto los bytes actuales", async () => {
    const fs = withDoc();
    const request = await prepared(fs);
    const inventory = request.inventory as {
      categories: { research: { docs: Array<{ digest: string }> } };
    };
    const result = validatePersist(
      answer(request, {
        decisions: { ...UPDATE, target_digest: inventory.categories.research.docs[0]?.digest },
      }),
      request,
    );
    if (!result.ok) throw new Error(`expected it to validate: ${result.failure.message}`);
    expect(result.value.preview).toMatchObject({ mode: "update", target: UPDATE.target });
  });

  it("rechaza un update sin target_digest", async () => {
    const fs = withDoc();
    const request = await prepared(fs);
    const result = validatePersist(answer(request, { decisions: UPDATE }), request);
    if (result.ok) throw new Error("expected a rejection");
    expect(result.failure.message).toContain("target_digest");
  });

  it("rechaza un update cuyo digest quedó viejo", async () => {
    const fs = withDoc();
    const request = await prepared(fs);
    const result = validatePersist(
      answer(request, { decisions: { ...UPDATE, target_digest: "0".repeat(64) } }),
      request,
    );
    if (result.ok) throw new Error("expected a rejection");
    expect(result.failure.code).toBe("SEMANTIC_STALE");
  });

  it("rechaza un update contra un documento que no está en el inventario", async () => {
    const fs = withDoc();
    const request = await prepared(fs);
    const result = validatePersist(
      answer(request, {
        decisions: {
          ...UPDATE,
          target: "docs/research/099-research-fantasma.md",
          target_digest: "0".repeat(64),
        },
      }),
      request,
    );
    if (result.ok) throw new Error("expected a rejection");
    expect(result.failure.message).toContain("no está en el inventario");
  });
});

// ── apply ────────────────────────────────────────────────────────────────────

function approvalFor(request: SemanticRequest, raw: string): string {
  const validated = validatePersist(raw, request);
  if (!validated.ok) throw new Error(`expected it to validate: ${validated.failure.message}`);
  return validated.value.approval_digest;
}

describe("applyPersist — writes exactly the approved proposal, or nothing", () => {
  it("crea un único documento en la categoría aprobada", async () => {
    const fs = workspace();
    const request = await prepared(fs);
    const raw = answer(request);
    const result = await applyPersist(fs, env, paths(), {
      raw,
      request,
      approval: approvalFor(request, raw),
    });

    if (!result.ok) throw new Error(`expected it to apply: ${result.failure.message}`);
    expect(result.value.written).toEqual(["docs/research/001-research-comparar-motores.md"]);
    expect(await fs.readText("/cwd/docs/research/001-research-comparar-motores.md")).toContain(
      "Análisis",
    );
  });

  // The consultative number in the answer is not the number that lands: two
  // existing docs mean the next one is 003, whatever the proposal said.
  it("reasigna el número dentro del lock, ignorando el que trajo la respuesta", async () => {
    const fs = workspace();
    fs.file("/cwd/docs/research/001-research-a.md", "# A\n");
    fs.file("/cwd/docs/research/002-research-b.md", "# B\n");
    const request = await prepared(fs);
    const raw = answer(request, {
      artifacts: [{ path: "docs/research/001-research-comparar-motores.md", content: "# Nuevo\n" }],
    });
    const result = await applyPersist(fs, env, paths(), {
      raw,
      request,
      approval: approvalFor(request, raw),
    });

    if (!result.ok) throw new Error(`expected it to apply: ${result.failure.message}`);
    expect(result.value.written).toEqual(["docs/research/003-research-comparar-motores.md"]);
    expect(await fs.exists("/cwd/docs/research/001-research-comparar-motores.md")).toBe(false);
  });

  it("rechaza un approval que no corresponde, sin escribir", async () => {
    const fs = workspace();
    const request = await prepared(fs);
    const raw = answer(request);
    const result = await applyPersist(fs, env, paths(), {
      raw,
      request,
      approval: "no-es-el-digest",
    });

    if (result.ok) throw new Error("expected a rejection");
    expect(result.failure.code).toBe("APPROVAL_MISMATCH");
    expect([...fs.writes.keys()]).toEqual([]);
  });

  it("rechaza cuando docs/ cambió entre la aprobación y la escritura", async () => {
    const fs = workspace();
    const request = await prepared(fs);
    const raw = answer(request);
    const approval = approvalFor(request, raw);

    // Someone else lands a document in the window.
    fs.file("/cwd/docs/specs/009-spec-ajena.md", "# Ajena\n");

    const result = await applyPersist(fs, env, paths(), { raw, request, approval });
    if (result.ok) throw new Error("expected a rejection");
    expect(result.failure.code).toBe("SEMANTIC_STALE");
    expect(await fs.exists("/cwd/docs/research/001-research-comparar-motores.md")).toBe(false);
  });

  it("no sobrescribe un documento existente en modo new", async () => {
    const fs = workspace();
    fs.file("/cwd/docs/research/001-research-comparar-motores.md", "# Original\n");
    const request = await prepared(fs);
    // The answer proposes 001, but apply mints 002 — so build a collision the
    // only way it can really happen: a file appearing at the minted path.
    const raw = answer(request, {
      artifacts: [
        { path: "docs/research/001-research-comparar-motores.md", content: "# Reemplazo\n" },
      ],
    });
    const approval = approvalFor(request, raw);
    const result = await applyPersist(fs, env, paths(), { raw, request, approval });

    if (!result.ok) throw new Error(`expected it to apply: ${result.failure.message}`);
    // The original is intact; the new one landed beside it.
    expect(await fs.readText("/cwd/docs/research/001-research-comparar-motores.md")).toBe(
      "# Original\n",
    );
    expect(result.value.written).toEqual(["docs/research/002-research-comparar-motores.md"]);
  });

  it("nunca crea una sesión", async () => {
    const fs = workspace();
    const request = await prepared(fs);
    const raw = answer(request);
    await applyPersist(fs, env, paths(), {
      raw,
      request,
      approval: approvalFor(request, raw),
    });
    const touched = [...fs.writes.keys()].filter((p) => p.includes("/sessions/"));
    expect(touched).toEqual([]);
  });
});
