import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { GovernanceRecord } from "../../src/domain/design/governance.js";
import {
  checkGovernanceAuthority,
  computeRecordDigest,
  decisionOn,
  judgeExecution,
  validateDesignReview,
  validateDesignRevocation,
} from "../../src/domain/design/governance.js";
import { validateDesignManifest } from "../../src/domain/design/manifest.js";
import type { DesignManifest } from "../../src/domain/design/manifest.js";

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../fixtures/design/${name}`, import.meta.url)), "utf8");

const read = <T>(name: string): T => JSON.parse(fixture(name)) as T;

/** Re-seal a record after changing it: a record whose digest lies is invalid. */
function reseal<T extends GovernanceRecord>(record: T, patch: Partial<T>): T {
  const next = { ...record, ...patch };
  return { ...next, digest: computeRecordDigest(next) };
}

function review(patch: Partial<GovernanceRecord> = {}): GovernanceRecord {
  return reseal(read<GovernanceRecord>("REV-001-approved.json"), patch);
}

function revocation(patch: Partial<GovernanceRecord> = {}): GovernanceRecord {
  return reseal(read<GovernanceRecord>("RVK-001-bloqueo.json"), patch);
}

/** Un record que decide sobre una revisión REAL: nombre y bytes. */
function sobre(
  kind: "review" | "revocation",
  revision: number,
  patch: Partial<GovernanceRecord> = {},
): GovernanceRecord {
  const m = manifest();
  const base = { target: `DES-001@r${revision}`, target_digest: digestOf(m, revision) };
  return kind === "review" ? review({ ...base, ...patch }) : revocation({ ...base, ...patch });
}

/** El digest real que el manifest publica para una revisión. */
const digestOf = (m: DesignManifest, revision: number): string =>
  m.baselines.find((b) => b.revision === revision)?.digest ?? "";

/** The package as published: `DES-001@r2` is current, `@r1` is superseded. */
function manifest(): DesignManifest {
  const parsed = validateDesignManifest(read("manifest-maximal.json"));
  if (!parsed.ok || parsed.value === null) {
    throw new Error(`el fixture no valida: ${parsed.failures[0]?.message}`);
  }
  return parsed.value;
}

describe("un record de gobierno se sella a sí mismo", () => {
  it("los fixtures validan y su digest es el de su contenido", () => {
    expect(validateDesignReview(read("REV-001-approved.json"), "rev.json").ok).toBe(true);
    expect(validateDesignRevocation(read("RVK-001-bloqueo.json"), "rvk.json").ok).toBe(true);
  });

  it("cambiar la decisión sin resellar invalida el record", () => {
    const mentiroso = { ...read<GovernanceRecord>("REV-001-approved.json"), decision: "rejected" };
    const result = validateDesignReview(mentiroso, "rev.json");
    expect(result.ok).toBe(false);
    expect(result.failures[0]?.code).toBe("DESIGN_DIGEST_MISMATCH");
  });

  it("el digest se calcula SIN el campo digest", () => {
    const record = read<GovernanceRecord>("REV-001-approved.json");
    const { digest, ...sin } = record;
    expect(computeRecordDigest(sin as GovernanceRecord)).toBe(digest);
  });

  it("una revocación sin razón no es auditable", () => {
    const result = validateDesignRevocation(revocation({ reason: "" }), "rvk.json");
    expect(result.ok).toBe(false);
    expect(result.failures[0]?.action).toContain("auditable");
  });

  it("un record que apunta a un package y no a una revisión se rechaza", () => {
    const result = validateDesignReview(review({ target: "DES-001" }), "rev.json");
    expect(result.ok).toBe(false);
    expect(result.failures[0]?.action).toContain("UNA revisión");
  });

  it("y uno sin el digest de su objetivo aprueba un nombre, no unos bytes", () => {
    const result = validateDesignReview(review({ target_digest: "sha256:corto" }), "rev.json");
    expect(result.ok).toBe(false);
    expect(result.failures[0]?.action).toContain("bytes");
  });
});

/**
 * La matriz que pide la validación de fase: cuatro dimensiones, y mover una no
 * mueve las otras tres.
 */
describe("madurez, review, currentness y política se mueven por separado", () => {
  const SIN_POLITICA = { requireApproval: false };
  const CON_POLITICA = { requireApproval: true };

  it("REVIEW: aprobar no toca la madurez ni la currentness ni deja de ejecutar", () => {
    const m = manifest();
    const antes = JSON.stringify({ catalog: m.catalog, currentness: m.currentness });
    const veredicto = judgeExecution(m, "DES-001@r2", [review()], SIN_POLITICA);
    expect(veredicto.executable).toBe(true);
    expect(JSON.stringify({ catalog: m.catalog, currentness: m.currentness })).toBe(antes);
  });

  it("CURRENTNESS: superseded AVISA y sigue ejecutable", () => {
    const veredicto = judgeExecution(manifest(), "DES-001@r1", [], SIN_POLITICA);
    expect(veredicto.executable).toBe(true);
    expect(veredicto.failures).toEqual([]);
    expect(veredicto.notices[0]).toContain("superseded");
  });

  it("REVOCACIÓN: es lo único que bloquea, y lo dice con su razón", () => {
    const veredicto = judgeExecution(manifest(), "DES-001@r2", [revocation()], SIN_POLITICA);
    expect(veredicto.executable).toBe(false);
    expect(veredicto.failures[0]?.code).toBe("DESIGN_REVISION_REVOKED");
    expect(veredicto.failures[0]?.message).toContain("expone el documento");
  });

  it("y una revocación de OTRA revisión no bloquea esta", () => {
    const otra = sobre("revocation", 1);
    expect(judgeExecution(manifest(), "DES-001@r2", [otra], SIN_POLITICA).executable).toBe(true);
  });

  it("POLÍTICA desactivada: se ejecuta sin ninguna aprobación", () => {
    expect(judgeExecution(manifest(), "DES-001@r2", [], SIN_POLITICA).executable).toBe(true);
  });

  it("POLÍTICA activada: el mismo baseline sin aprobación falla cerrado", () => {
    const veredicto = judgeExecution(manifest(), "DES-001@r2", [], CON_POLITICA);
    expect(veredicto.executable).toBe(false);
    expect(veredicto.failures[0]?.code).toBe("DESIGN_APPROVAL_MISSING");
  });

  it("POLÍTICA activada: con la aprobación de ESA revisión, se ejecuta", () => {
    expect(judgeExecution(manifest(), "DES-001@r2", [review()], CON_POLITICA).executable).toBe(
      true,
    );
  });

  it("y la política no altera la madurez de nada", () => {
    const m = manifest();
    const antes = m.catalog.screens.map((s) => s.maturity);
    judgeExecution(m, "DES-001@r2", [], CON_POLITICA);
    expect(m.catalog.screens.map((s) => s.maturity)).toEqual(antes);
  });
});

describe("una aprobación no se hereda", () => {
  it("aprobar la r1 no aprueba la r2", () => {
    const vieja = sobre("review", 1);
    const veredicto = judgeExecution(manifest(), "DES-001@r2", [vieja], { requireApproval: true });
    expect(veredicto.executable).toBe(false);
    expect(veredicto.failures[0]?.action).toContain("no se hereda");
  });

  it("una revisión sin records nace 'proposed'", () => {
    expect(decisionOn("DES-001@r2", [])).toBe("proposed");
  });

  it("y la última decisión por fecha es la que rige", () => {
    const records = [
      review({ id: "REV-001", decision: "approved", date: "2026-08-01" }),
      review({ id: "REV-002", decision: "rejected", date: "2026-08-02" }),
    ];
    expect(decisionOn("DES-001@r2", records)).toBe("rejected");
    expect(decisionOn("DES-001@r2", [...records].reverse())).toBe("rejected");
  });

  it("un rechazo no bloquea por sí solo: bloquear es cosa de una revocación", () => {
    const rechazo = review({ decision: "rejected" });
    const veredicto = judgeExecution(manifest(), "DES-001@r2", [rechazo], {
      requireApproval: false,
    });
    expect(veredicto.executable).toBe(true);
  });
});

describe("juzgar un baseline que no es de este package", () => {
  it("no se resuelve por parecido", () => {
    const veredicto = judgeExecution(manifest(), "DES-002@r2", [], { requireApproval: false });
    expect(veredicto.executable).toBe(false);
    expect(veredicto.failures[0]?.code).toBe("DESIGN_REFERENCE_MISSING");
  });
});

describe("el índice del manifest ubica los records", () => {
  const conPath = (path: string) => {
    const raw = read<Record<string, unknown>>("manifest-maximal.json");
    (raw.governance as { reviews: Array<Record<string, unknown>> }).reviews[0].path = path;
    return validateDesignManifest(raw);
  };

  it("un review fuera de governance/reviews/ se rechaza nombrando su lugar", () => {
    const result = conPath("reviews/REV-001.json");
    expect(result.ok).toBe(false);
    expect(result.failures[0]?.action).toContain("governance/reviews/REV-001.json");
  });

  it("y un review cuyo archivo no se llama como su id, también", () => {
    const result = conPath("governance/reviews/aprobacion.json");
    expect(result.ok).toBe(false);
    expect(result.failures[0]?.message).toContain("no es la ubicación de REV-001");
  });

  it("un record que decide sobre el baseline de OTRO package no se indexa acá", () => {
    const raw = read<Record<string, unknown>>("manifest-maximal.json");
    (raw.governance as { reviews: Array<Record<string, unknown>> }).reviews[0].target =
      "DES-999@r2";
    const result = validateDesignManifest(raw);
    expect(result.ok).toBe(false);
    expect(result.failures[0]?.code).toBe("DESIGN_RELATION_BROKEN");
    expect(result.failures[0]?.message).toContain("no es de DES-001");
  });

  it("el fixture, que sí los ubica bien, valida", () => {
    expect(validateDesignManifest(read("manifest-maximal.json")).ok).toBe(true);
  });
});

describe("un record decide sobre BYTES, no sobre un número", () => {
  const CON_POLITICA = { requireApproval: true };

  it("una aprobación que cita otro digest no aprueba esta revisión", () => {
    const ajeno = review({ target_digest: `sha256:${"de".repeat(32)}` });
    const veredicto = judgeExecution(manifest(), "DES-001@r2", [ajeno], CON_POLITICA);
    expect(veredicto.executable).toBe(false);
    expect(veredicto.failures[0]?.code).toBe("DESIGN_APPROVAL_MISSING");
  });

  it("y una revocación que cita otro digest no bloquea", () => {
    const ajena = revocation({ target_digest: `sha256:${"de".repeat(32)}` });
    expect(
      judgeExecution(manifest(), "DES-001@r2", [ajena], { requireApproval: false }).executable,
    ).toBe(true);
  });

  it("citando el digest real, aprueba", () => {
    expect(
      judgeExecution(manifest(), "DES-001@r2", [sobre("review", 2)], CON_POLITICA).executable,
    ).toBe(true);
  });
});

describe("la política lee la decisión VIGENTE", () => {
  it("un rechazo posterior retira la aprobación", () => {
    const secuencia = [
      sobre("review", 2, { id: "REV-001", decision: "approved", date: "2026-08-01" }),
      sobre("review", 2, { id: "REV-002", decision: "rejected", date: "2026-08-05" }),
    ];
    const veredicto = judgeExecution(manifest(), "DES-001@r2", secuencia, {
      requireApproval: true,
    });
    expect(veredicto.executable).toBe(false);
    // Y da igual el orden del array: manda la fecha.
    expect(
      judgeExecution(manifest(), "DES-001@r2", [...secuencia].reverse(), { requireApproval: true })
        .executable,
    ).toBe(false);
  });

  it("y una aprobación posterior al rechazo vuelve a habilitar", () => {
    const secuencia = [
      sobre("review", 2, { id: "REV-001", decision: "rejected", date: "2026-08-01" }),
      sobre("review", 2, { id: "REV-002", decision: "approved", date: "2026-08-05" }),
    ];
    expect(
      judgeExecution(manifest(), "DES-001@r2", secuencia, { requireApproval: true }).executable,
    ).toBe(true);
  });
});

describe("una revisión que nadie publicó no se juzga", () => {
  it("se nombra el problema real, no una aprobación que falta", () => {
    const veredicto = judgeExecution(manifest(), "DES-001@r99", [], { requireApproval: true });
    expect(veredicto.executable).toBe(false);
    expect(veredicto.failures[0]?.code).toBe("DESIGN_REFERENCE_MISSING");
    expect(veredicto.failures[0]?.action).toContain("r1, r2");
  });
});

describe("la fecha de un record tiene que existir", () => {
  it("2026-13-45 tiene la forma y no es un día", () => {
    expect(validateDesignReview(review({ date: "2026-13-45" }), "rev.json").ok).toBe(false);
  });

  it("y 9999-99-99 tampoco, que era el que se anclaba arriba", () => {
    expect(validateDesignReview(review({ date: "9999-99-99" }), "rev.json").ok).toBe(false);
  });
});

describe("un contrato que no entendemos se dice como tal", () => {
  it("un schema desconocido es DESIGN_SCHEMA_UNKNOWN, no un campo inválido", () => {
    const result = validateDesignReview(review({ schema: "workline.design-review/v2" }), "r.json");
    expect(result.ok).toBe(false);
    expect(result.failures[0]?.code).toBe("DESIGN_SCHEMA_UNKNOWN");
    // «Actualizá la CLI» y «arreglá el campo» mandan a lugares distintos.
    expect(result.failures[0]?.action).toContain("entiende");
  });

  it("y el gate corre PRIMERO: no se reportan defectos derivados de un formato ajeno", () => {
    // Todo lo demás roto a la vez: si el gate no cortara, saldrían seis fallos
    // de campos que ese contrato quizá ni tiene.
    const ajeno = { schema: "workline.design-review/v2", id: "X", target: "no", date: "ayer" };
    const result = validateDesignReview(ajeno, "r.json");
    expect(result.failures).toHaveLength(1);
  });

  it("la revocación se comporta igual que su módulo hermano", () => {
    const result = validateDesignRevocation(
      revocation({ schema: "workline.design-revocation/v2" }),
      "v.json",
    );
    expect(result.failures[0]?.code).toBe("DESIGN_SCHEMA_UNKNOWN");
  });
});

describe("evidence no repite", () => {
  it("citar dos veces la misma fuente no la hace más evidencia", () => {
    const repetida = review({ evidence: ["a.md", "a.md"] });
    const result = validateDesignReview(repetida, "rev.json");
    expect(result.ok).toBe(false);
    expect(result.failures[0]?.code).toBe("DESIGN_ID_DUPLICATE");
  });
});

describe("el índice y el record dicen lo mismo", () => {
  const PKG = "docs/designs/001-design-alta";
  const enDisco = (patch: Partial<GovernanceRecord> = {}) =>
    new Map<string, GovernanceRecord>([
      ["governance/reviews/REV-001.json", review({ digest: undefined, ...patch } as never)],
      ["governance/revocations/RVK-001.json", sobre("revocation", 1)],
    ]);

  it("un índice que promete un archivo ausente se reporta", () => {
    const failures = checkGovernanceAuthority(manifest(), new Map(), PKG);
    expect(failures[0]?.code).toBe("DESIGN_REFERENCE_FILE_MISSING");
    expect(failures[0]?.artifact).toContain("governance/reviews/REV-001.json");
  });

  it("un índice cuyo digest no es el del record se reporta nombrando al record como autoridad", () => {
    const failures = checkGovernanceAuthority(manifest(), enDisco(), PKG);
    const digestFail = failures.find((f) => f.message.includes("digest"));
    expect(digestFail?.code).toBe("DESIGN_AUTHORITY_CONFLICT");
    expect(digestFail?.action).toContain("el record es la autoridad");
  });

  it("y un id distinto del indexado también", () => {
    const failures = checkGovernanceAuthority(manifest(), enDisco({ id: "REV-777" }), PKG);
    expect(failures.some((f) => f.message.includes("REV-777"))).toBe(true);
  });
});
