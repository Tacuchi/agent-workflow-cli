import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateDesignBaseline } from "../../src/domain/design/baseline.js";
import { validateDesignManifest } from "../../src/domain/design/manifest.js";
import { findSecrets, secretFailures } from "../../src/domain/design/secrets.js";

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../fixtures/design/${name}`, import.meta.url)), "utf8");

/** Item `i` of an array, without a non-null assertion the linter forbids. */
function at(list: unknown, index: number): Record<string, unknown> {
  return (list as Array<Record<string, unknown>>)[index] as Record<string, unknown>;
}

/**
 * Every credential SHAPE this suite feeds the detector is assembled at runtime.
 *
 * Not decoration: the repo's own secret guard scans what gets written, and a
 * literal PEM header or `AKIA…` in this file would trip it on every edit. A
 * repo-wide grep for secrets should not have to special-case the test that
 * exercises the secret detector — so the file contains no secret-shaped literal,
 * and the detector still receives the exact string it must recognize.
 */
const SHAPES = {
  pem: `${["-----BEGIN", "RSA", "PRIVATE", "KEY-----"].join(" ")}\nMIIEowIBAAKCAQEA`,
  github: `gh${"p"}_${"a".repeat(36)}`,
  githubFine: `git${"hub"}_pat_${"b".repeat(30)}`,
  slack: `xox${"b"}-${"1".repeat(20)}`,
  aws: `AK${"IA"}IOSFODNN7EXAMPLE`,
  apiKey: `s${"k"}-${"c".repeat(32)}`,
  jwt: `ey${"J"}hbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27u`,
  bearer: `Bea${"rer"} ${"d".repeat(30)}`,
  urlWithPassword: `https://usuario:s3${"cr"}3t@figma.com/file/abc`,
};

describe("findSecrets — una clave que se llama credencial ES la credencial", () => {
  it.each([
    "password",
    "secret",
    "client_secret",
    "token",
    "access_token",
    "api_key",
    "apiKey",
    "private_key",
    "cookie",
  ])("reporta un campo '%s' con cualquier contenido", (key) => {
    const findings = findSecrets({ locator: { [key]: "lo-que-sea" } });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.at).toBe(`locator.${key}`);
  });

  it("no reporta el campo vacío ni la clasificación de acceso", () => {
    expect(findSecrets({ locator: { token: "" } })).toEqual([]);
    expect(findSecrets({ locator: { access: "private", visibility: "team" } })).toEqual([]);
  });

  // `authorization` NO está en la lista de claves: la spec le pide al package
  // registrar bajo qué autorización se envía algo, y flaggear ese vocabulario
  // sería rechazar justo el dato que el contrato exige guardar. El header real
  // se caza igual, por su forma.
  it("deja pasar la autorización como estado y caza el header por su forma", () => {
    expect(findSecrets({ rendition: { authorization: "explícita" } })).toEqual([]);
    expect(findSecrets({ rendition: { authorization: SHAPES.bearer } })).toHaveLength(1);
  });

  // Envolver una credencial en un objeto no la vuelve otro campo.
  it("ve el campo de credencial aunque su valor no sea un string", () => {
    expect(findSecrets({ locator: { token: { value: "opaco" } } })).toEqual([
      { at: "locator.token", what: "un campo 'token'" },
    ]);
    expect(findSecrets({ locator: { api_key: ["a", "b"] } })).toHaveLength(1);
    expect(findSecrets({ locator: { token: {} } })).toEqual([]);
  });
});

describe("findSecrets — una forma de credencial se reconoce donde esté", () => {
  it.each(Object.entries(SHAPES))("reconoce %s aunque la clave sea inocente", (_name, value) => {
    const findings = findSecrets({ rendition: { note: value } });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.at).toBe("rendition.note");
  });

  // El caso que hay que NO romper: un locator de proveedor es todo lo que el
  // contrato pide guardar, y no contiene nada que otorgue acceso.
  it("no confunde un locator legítimo de Figma con una credencial", () => {
    expect(
      findSecrets({
        locator: {
          provider: "figma",
          file_key: "AbC123dEf456",
          node_id: "12:345",
          version_id: "987654321",
          url: "https://www.figma.com/file/AbC123dEf456/alta?node-id=12%3A345",
          access: "private",
        },
      }),
    ).toEqual([]);
  });

  it("reporta cada hallazgo, no solo el primero", () => {
    const findings = findSecrets({
      a: { token: "x" },
      b: [{ note: SHAPES.github }],
    });
    expect(findings.map((f) => f.at)).toEqual(["a.token", "b[0].note"]);
  });

  it("el diagnóstico dice qué hacer, y que rotar no alcanza", () => {
    const failure = secretFailures({ locator: { token: "abc" } }, "renditions/VIS-001/x.json")[0];
    expect(failure?.code).toBe("DESIGN_SECRET_PRESENT");
    expect(failure?.action).toContain("CLASIFICACIÓN");
    expect(failure?.action).toContain("historial de git");
  });
});

describe("ni el manifest ni el baseline admiten una credencial", () => {
  it("el manifest la rechaza", () => {
    const doc = JSON.parse(fixture("manifest-maximal.json")) as Record<string, unknown>;
    doc.title = `Alta — ver ${SHAPES.github}`;
    expect(validateDesignManifest(doc).failures.map((f) => f.code)).toContain(
      "DESIGN_SECRET_PRESENT",
    );
  });

  it("el baseline la rechaza", () => {
    const doc = JSON.parse(fixture("baseline-DES-001-r002.json")) as Record<string, unknown>;
    at(doc.selection as Array<Record<string, unknown>>, 0).path =
      `flows/FLW-001-r002-alta-miembro.md?key=${SHAPES.aws}`;
    expect(
      validateDesignBaseline(doc, "baselines/DES-001-r002.json").failures.map((f) => f.code),
    ).toContain("DESIGN_SECRET_PRESENT");
  });
});
