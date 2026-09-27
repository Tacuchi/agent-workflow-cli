import { describe, expect, it } from "vitest";
import {
  alignSpecBaseline,
  legacySpecBaselineDigest,
  specBaselineDigest,
} from "../../src/domain/lineage.js";
import {
  baseDigest,
  canonicalEol,
  legacyBaseDigest,
  matchTextSeal,
} from "../../src/domain/proposal.js";
import {
  custodyCompleteness,
  custodyDigest,
  sealCustody,
} from "../../src/domain/session/custody.js";

describe("sellos de documentos y fin de línea", () => {
  const lf = "# Plan\n\n- [ ] tarea\n";
  const crlf = lf.replace(/\n/g, "\r\n");

  it("sella igual LF y CRLF sin alterar el texto original", () => {
    expect(canonicalEol(crlf)).toBe(lf);
    expect(baseDigest(crlf)).toBe(baseDigest(lf));
    expect(matchTextSeal(baseDigest(lf), crlf)).toBe("eol-only");
    expect(matchTextSeal(baseDigest(lf), lf)).toBe("exact");
  });

  it("acepta sellos anteriores sobre bytes LF y CRLF sin aceptar cambios de contenido", () => {
    expect(matchTextSeal(legacyBaseDigest(lf), lf)).toBe("exact");
    expect(matchTextSeal(legacyBaseDigest(crlf), crlf)).toBe("legacy");
    expect(matchTextSeal(legacyBaseDigest(crlf), `${crlf}otra línea`)).toBeNull();
    expect(matchTextSeal(baseDigest(lf), lf.replace("tarea", "otra"))).toBeNull();
  });

  it("una custodia antigua sobre CRLF sigue íntegra sin reescribir su sello", () => {
    const sealed = sealCustody({
      subject: { kind: "session", key: "001-sellos" },
      subjectPath: "/tmp/001-sellos",
      created: "2026-09-27",
      artifacts: [
        {
          path: "docs/plans/001-plan.md",
          role: "input",
          before: {
            existed: true,
            digest: legacyBaseDigest(crlf),
            bytes: Buffer.byteLength(crlf),
            content: crlf,
          },
        },
      ],
    });
    const { digest: _newDigest, ...body } = sealed;
    const old = { ...sealed, digest: custodyDigest(body, true) };
    expect(old.digest).not.toBe(sealed.digest);
    expect(custodyCompleteness(old)).toEqual({ complete: true, gaps: [] });
  });

  it("un baseline exacto anterior sobre CRLF permanece alineado", () => {
    expect(
      alignSpecBaseline(
        {
          status: "sealed",
          baseline: {
            path: "docs/specs/001-spec.md",
            number: "001",
            digest: legacySpecBaselineDigest(crlf),
          },
        },
        {
          functional: specBaselineDigest(crlf),
          exact: specBaselineDigest(crlf),
          legacy_exact: legacySpecBaselineDigest(crlf),
        },
      ),
    ).toEqual({ status: "aligned", digest: specBaselineDigest(crlf) });
  });
});
