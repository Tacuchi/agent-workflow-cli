import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  compareVersions,
  contractsBetween,
  parseChangelogContracts,
  parseVersion,
} from "../../src/domain/changelog-contract.js";

/** The last version cut before the convention: every later one must declare its section. */
const CONTRACT_CONVENTION_AFTER = "25.6.1";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

const FIXTURE = `# Changelog

**Contratos.** La convención menciona \`### Contrato\` sin abrir ninguna sección.

## [3.0.0] — 2026-10-03

### Contrato

- **Deja de valer:** el estado de corrida v6.
  **Lo reemplaza:** el estado de corrida v7.
  **Qué hacer:** re-adoptá la sesión con \`aw flow advance --adopt\`.
- **Deja de valer:** \`--old\`. **Lo reemplaza:** \`--new\`. **Qué hacer:** renombrá el flag.

### Added

- Algo nuevo.

## [2.1.0] — 2026-10-02

### Contrato

Ninguno.

## [2.0.1] — 2026-10-01

### Fixed

- Sin sección de contrato.

## [2.0.0] — 2026-09-30

### Contrato

- **Deja de valer:** algo. **Qué hacer:** otra cosa.

## [1.0.0] — 2026-05-DD

### Contrato

Ninguno.
`;

function contractOf(text: string, version: string) {
  return parseChangelogContracts(text).find((entry) => entry.version === version)?.contract;
}

describe("parseChangelogContracts — the three states of a version", () => {
  it("reads declared changes with their three labeled parts, across continuation lines", () => {
    expect(contractOf(FIXTURE, "3.0.0")).toEqual({
      kind: "changes",
      changes: [
        {
          stops: "el estado de corrida v6.",
          replacedBy: "el estado de corrida v7.",
          action: "re-adoptá la sesión con `aw flow advance --adopt`.",
        },
        { stops: "`--old`.", replacedBy: "`--new`.", action: "renombrá el flag." },
      ],
    });
  });

  it("reads «Ninguno.» as a declared absence of changes", () => {
    expect(contractOf(FIXTURE, "2.1.0")).toEqual({ kind: "none" });
  });

  it("reads an entry without the section as undeclared, never as none", () => {
    expect(contractOf(FIXTURE, "2.0.1")).toEqual({ kind: "undeclared" });
  });

  it("reports a section that breaks the form instead of reading it as changes or none", () => {
    const contract = contractOf(FIXTURE, "2.0.0");
    expect(contract?.kind).toBe("malformed");
    if (contract?.kind === "malformed") expect(contract.problem).toContain("**Lo reemplaza:**");
  });

  it("rejects «Ninguno.» mixed with a change and an empty section", () => {
    const mixed =
      "## [1.0.0]\n\n### Contrato\n\nNinguno.\n- **Deja de valer:** a **Lo reemplaza:** b **Qué hacer:** c\n";
    const empty = "## [1.0.0]\n\n### Contrato\n\n### Added\n";
    expect(contractOf(mixed, "1.0.0")?.kind).toBe("malformed");
    expect(contractOf(empty, "1.0.0")?.kind).toBe("malformed");
  });
});

describe("contractsBetween — the versions a jump crosses", () => {
  const entries = parseChangelogContracts(FIXTURE);

  it("takes installed excluded and target included, in ascending order", () => {
    const range = contractsBetween(entries, "2.0.0", "3.0.0");
    expect(range.kind).toBe("range");
    if (range.kind === "range") {
      expect(range.entries.map((entry) => entry.version)).toEqual(["2.0.1", "2.1.0", "3.0.0"]);
    }
  });

  it("compares versions numerically, not as text", () => {
    const text =
      "## [10.0.0]\n\n### Contrato\n\nNinguno.\n\n## [9.0.0]\n\n### Contrato\n\nNinguno.\n";
    const range = contractsBetween(parseChangelogContracts(text), "2.0.0", "10.0.0");
    if (range.kind !== "range") throw new Error("expected a range");
    expect(range.entries.map((entry) => entry.version)).toEqual(["9.0.0", "10.0.0"]);
  });

  it("is empty when the target is not newer than the installed version", () => {
    expect(contractsBetween(entries, "3.0.0", "3.0.0")).toEqual({ kind: "range", entries: [] });
  });

  it("lists a target the changelog does not name as undeclared", () => {
    const range = contractsBetween(entries, "3.0.0", "3.1.0");
    expect(range).toEqual({
      kind: "range",
      entries: [{ version: "3.1.0", contract: { kind: "undeclared" } }],
    });
  });

  it("names an unreadable installed version instead of choosing a range", () => {
    expect(contractsBetween(entries, "unknown", "3.0.0")).toEqual({
      kind: "unknown-version",
      role: "installed",
      value: "unknown",
    });
  });
});

describe("the changelog contract — a release cannot ship without its section", () => {
  /** What keeps `version` from shipping, read from the live parser. */
  const problemsOf = (text: string, version: string): string[] => {
    const entries = parseChangelogContracts(text);
    const problems = entries.flatMap((entry) =>
      entry.contract.kind === "malformed" ? [`${entry.version}: ${entry.contract.problem}`] : [],
    );
    const current = parseVersion(version);
    const floor = parseVersion(CONTRACT_CONVENTION_AFTER);
    if (current === null || floor === null || compareVersions(current, floor) <= 0) return problems;
    const entry = entries.find((candidate) => candidate.version === version);
    if (entry === undefined) return [...problems, `${version}: sin entrada`];
    return entry.contract.kind === "undeclared"
      ? [...problems, `${version}: sin sección`]
      : problems;
  };

  it("an entry after 25.6.1 without the section reads as undeclared", () => {
    const text = "## [25.7.0] — 2026-10-01\n\n### Fixed\n\n- Algo.\n";
    expect(problemsOf(text, "25.7.0")).toEqual(["25.7.0: sin sección"]);
  });

  it("a version after 25.6.1 with no entry at all is caught", () => {
    expect(problemsOf("## [25.6.1]\n", "25.7.0")).toEqual(["25.7.0: sin entrada"]);
  });

  it("any malformed section is caught, whatever its version", () => {
    expect(problemsOf(FIXTURE, "1.0.0")).toEqual(["2.0.0: cambio 1: le falta **Lo reemplaza:**"]);
  });

  it("passes on the repository changelog at the version package.json declares", () => {
    const changelog = readFileSync(`${repoRoot}CHANGELOG.md`, "utf8");
    const { version } = JSON.parse(readFileSync(`${repoRoot}package.json`, "utf8")) as {
      version: string;
    };
    expect(problemsOf(changelog, version)).toEqual([]);
  });

  it("reads the five DOC-04 ruptures from the repository changelog as declared changes", () => {
    const changelog = readFileSync(`${repoRoot}CHANGELOG.md`, "utf8");
    const floor = parseVersion(CONTRACT_CONVENTION_AFTER);
    const backfilled = parseChangelogContracts(changelog).flatMap((entry) => {
      const version = parseVersion(entry.version);
      const beforeConvention =
        version !== null && floor !== null && compareVersions(version, floor) <= 0;
      return beforeConvention && entry.contract.kind === "changes"
        ? entry.contract.changes.map(() => entry.version)
        : [];
    });
    expect(backfilled).toEqual(["25.1.0", "22.0.0", "22.0.0", "21.16.0", "21.10.0"]);
  });
});
