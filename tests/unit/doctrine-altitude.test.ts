import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { functionalSpecDigest } from "../../src/application/parsers/spec-functional.js";
import {
  parsePlanBaselineSeal,
  parseSpecCriteria,
  parseSpecRelation,
} from "../../src/application/parsers/spec-relation.js";
import { ALL_COMMANDS } from "../../src/cli/commands/index.js";
import { alignSpecBaseline, specBaselineDigest } from "../../src/domain/lineage.js";

// Doctrine ALTITUDE guards (lote G — the spec is the functional "what", the plan
// the technical "how").
//
// These are not spelling pins: each one runs the CLI half of the contract the
// doctrine now claims, and only then demands the sentence that matches it. The
// class of defect they close is a document promising, in the present indicative,
// behavior the shipped CLI answers the other way around — the reader then either
// gets stuck in a loop the doctrine says cannot happen, or reads a real
// diagnostic as a defect.
//
// Every check that depends on an INCOMING contract is written conditionally
// against the code: the day the parallel batch lands the derivation, the seal or
// the standalone route, the condition flips on its own instead of pinning a
// caveat that has become false.
const SKILL_ROOT = resolve(__dirname, "..", "..", "skills", "w");
const SRC_ROOT = resolve(__dirname, "..", "..", "src");

const read = (rel: string): Promise<string> => readFile(join(SKILL_ROOT, rel), "utf8");
const readSrc = (rel: string): Promise<string> => readFile(join(SRC_ROOT, rel), "utf8");

async function listMd(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listMd(full)));
    else if (entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

/** The lines the draft schema of `spec-new` offers as acceptance criteria. */
function templateCriteria(doc: string): string[] {
  return doc.split(/\r?\n/).filter((line) => /^- \[ \]/.test(line));
}

describe("doctrine altitude — an acceptance criterion the CLI can actually address", () => {
  it("a criterion written with the spec-new template is harvested as an assertion", async () => {
    const criteria = templateCriteria(await read("commands/spec-new.md"));
    expect(criteria.length).toBeGreaterThan(1);
    // The template with its placeholder resolved is exactly what a new spec
    // carries. If the harvester sees nothing here, no spec born from this
    // command states an addressable assertion, and the composable exit of the
    // deviation gate is closed for every one of them.
    const spec = [
      "# Spec 040 — altitude",
      "",
      "## Acceptance criteria",
      ...criteria.map((line) => line.replace(/\{NNN\}/g, "040")),
      "",
    ].join("\n");
    // The number comes from the spec's own file name, which is what makes the
    // readable label addressable: the template no longer spells `S{NNN}/` by hand.
    expect(parseSpecCriteria(spec, "040")).toEqual(["S040/AC-01", "S040/AC-02"]);
  });

  it("the refine schema and its gate demand the same addressable form", async () => {
    const loop = await read("loops/spec-refine-loop/LOOP.md");
    expect(loop).toContain("- [ ] AC-nn");
    expect(loop).toContain("every criterion carries its `AC-nn` label");
  });

  it("the three surfaces name the refusal an unstated criterion earns, and the code still emits it", async () => {
    // Doctrine and code, tied both ways: a rename in the composer fails here
    // instead of leaving three documents naming a code nobody emits.
    expect(await readSrc("domain/effective-contract.ts")).toContain("CONTRACT_ASSERTION_ABSENT");
    for (const rel of [
      "commands/spec-new.md",
      "loops/spec-refine-loop/LOOP.md",
      "loops/plan-exec-loop/LOOP.md",
    ]) {
      expect(await read(rel), rel).toContain("CONTRACT_ASSERTION_ABSENT");
    }
    // And no document may go back to claiming the readable label is NOT
    // addressable: the harvester derives `S{NNN}` from the file number, so the
    // refusal belongs to a criterion the spec never states — not to one whose
    // line omits the prefix.
    const exec = await read("loops/plan-exec-loop/LOOP.md");
    expect(exec).toContain("**derives**");
    expect(exec).not.toContain("literally from the spec's text");
    expect(parseSpecCriteria("## Acceptance criteria\n- [ ] AC-07: x\n", "041")).toEqual([
      "S041/AC-07",
    ]);
  });
});

describe("doctrine altitude — the seal, and the exit a divergent one has", () => {
  it("the drift row matches what the seal actually reads", async () => {
    const spec = [
      "# Spec 040 — altitude",
      "",
      "## Requirement",
      "El comando responde con el plan publicado",
      "",
      "## Context",
      "El CLI ya publica planes",
      "",
      "## Acceptance criteria",
      "- [ ] AC-01: el comando responde con el plan publicado",
      "",
    ].join("\n");
    // Editorial BY CONSTRUCTION: the edit lands in `## Context`, a section the
    // functional payload does not read. Measuring this with the byte-exact digest
    // was the bug in the first version of this guard — that one is never blind.
    const editorial = spec.replace("publica planes", "publica planes.");
    expect(editorial).not.toEqual(spec);
    const blindToEditorial = functionalSpecDigest(spec) === functionalSpecDigest(editorial);
    expect(specBaselineDigest(spec)).not.toEqual(specBaselineDigest(editorial));

    const row = (await read("loops/plan-refine-loop/LOOP.md"))
      .split(/\r?\n/)
      .find((line) => line.includes("Plan↔spec drift"));
    expect(row).toBeDefined();
    if (blindToEditorial) {
      // The functional digest landed, so the row may claim an editorial edit is
      // not drift. A plan sealed BEFORE it still carries the byte-exact digest
      // and still reads divergent, so the row must keep naming that exit.
      expect(row).toMatch(/re-seal/i);
      return;
    }
    expect(row).not.toMatch(/no longer reads it as one/);
    expect(row).toMatch(/re-seal/i);
    expect(row).toMatch(/re-publication/);
  });

  it("`aw reseal` es un comando, y toda mención nombra un contrato que tiene", async () => {
    // La condición se dio vuelta sola: mientras el comando no existía, este
    // guard exigía que cada mención ofreciera la salida que sí existía (la
    // re-publicación del loop). Ahora existe, así que lo que se pinea es lo
    // nuevo — que el comando tenga los dos verbos que la doctrina promete, y que
    // ninguna mención ofrezca una salida que el CLI no da.
    const reseal = ALL_COMMANDS.find((command) => command.name === "reseal");
    expect(reseal, "`aw reseal` tiene que estar registrado").toBeDefined();
    expect(reseal?.describe ?? "").toContain("aw reseal prepare|apply");
    expect(reseal?.describe ?? "").toContain("--approval");

    const files = await listMd(SKILL_ROOT);
    let mentions = 0;
    for (const file of files) {
      const lines = (await readFile(file, "utf8")).split(/\r?\n/);
      lines.forEach((line, index) => {
        if (!line.includes("aw reseal")) return;
        mentions += 1;
        // Cada mención ofrece una salida REAL: los verbos del comando, o la
        // re-publicación que el propio loop hace al guardar. Una mención suelta
        // manda a alguien a un comando cuyo contrato no conoce.
        const window = lines.slice(index, index + 3).join(" ");
        expect(window, `${file}:${index + 1}`).toMatch(/prepare|re-publication/);
      });
    }
    expect(mentions).toBeGreaterThan(0);
  });
});

describe("doctrine altitude — a standalone plan and the board that reads it", () => {
  it("the MARKER's landing is what decides which claim gets pinned", async () => {
    const plan = [
      "# Plan 040 — standalone x",
      "",
      "> Standalone: conversacion del host · sesion 012-standalone-x",
      "> Limite de ejecucion: checkout",
      "",
      "## Origin",
      "adopted from host conversation",
      "",
    ].join("\n");
    const board = await readSrc("application/workline-index-service.ts");
    // The condition is the RELATION, not the alignment. A standalone plan has no
    // seal and never will, so `alignSpecBaseline` answers `unsealed` whether or
    // not the route landed — the first version of this guard conditioned on that
    // and could therefore never flip, which would have left it pinning "the notice
    // does reach it" after the notice stopped reaching it.
    if (parseSpecRelation(plan).status === "standalone") {
      // It landed, so what is pinned is the NEW claim: this plan is routed by its
      // own declared origin, and the legacy notice belongs to the plan that
      // carries no marker — the one whose provenance nobody can prove.
      expect(board).toContain('plan.spec.status === "standalone"');
      expect(board).toContain('mode: "standalone"');
      expect(board).toContain("WORKLINE_BASELINE_LEGACY_UNSEALED");
      // And the seal is STILL absent: the board did not start claiming an
      // alignment nobody computed, it stopped reading the absence as a defect.
      expect(alignSpecBaseline(parsePlanBaselineSeal(plan), null).status).toBe("unsealed");

      // The doctrine half, and the reason this branch is not a pin on source
      // strings: the marker the documents SPELL has to be the marker the parser
      // reads. A document that writes the label one way while the CLI accepts
      // another sends every plan born from it to the `absent` route — the notice
      // it was told it would not get, and a deviation gate that demands a lineage
      // the plan does not have.
      const marker = /`(> Standalone:[^`]+)`/.exec(await read("modules/PLAN-INPUT.md"))?.[1];
      expect(marker, "PLAN-INPUT tiene que deletrear el marcador").toBeDefined();
      const asDoctrineSpellsIt = [
        "# Plan 040 — standalone x",
        "",
        marker ?? "",
        "",
        "## Origin",
        "adopted from host conversation",
        "",
      ].join("\n");
      expect(parseSpecRelation(asDoctrineSpellsIt)).toEqual({ status: "standalone" });
      // And the destination it promises for a deviation is the one the gate really
      // writes to: the session's own file, never a `docs/decisions/` note.
      expect(await read("modules/PLAN-INPUT.md")).toContain("`DECISION.md`");
      expect(await readSrc("application/flow/submit.ts")).toContain("DECISION.md de la sesión");
      return;
    }

    expect(board).toContain("WORKLINE_BASELINE_LEGACY_UNSEALED");
    expect(board).toContain('mode: "compatible"');
    // The notice DOES reach it, so no doctrine file may say it does not, and the
    // module that owns the mode has to say what the board reports instead.
    for (const file of await listMd(SKILL_ROOT)) {
      expect(await readFile(file, "utf8"), file).not.toMatch(/no unsealed-baseline notice/);
    }
    const input = await read("modules/PLAN-INPUT.md");
    expect(input).toContain("`compatible` mode");
    expect(input).toContain("`> Derived from …`");
  });
});

describe("doctrine altitude — the lineage plan-exec really reads", () => {
  it("§ Reads names the resolution order the parser applies, header blockquote first", async () => {
    // The parser's order is fixed and its levels never merge: `> Derived from`
    // in the header blockquote, then a spec inside `## Origin`, and no spec at
    // all for a plan carrying `> Standalone:`. A document that puts `## Origin`
    // first sends the entry gate to a spec the plan did not declare, and leaves
    // a standalone plan — executable again — hunting for a source it has none of.
    const both = [
      "# Plan 041 — lineage",
      "",
      "> Derived from docs/specs/039-spec-header.md",
      "",
      "## Origin",
      "Spec 033",
      "",
    ].join("\n");
    expect(parseSpecRelation(both)).toEqual({
      status: "declared",
      number: "039",
      evidence: "derived-from",
    });
    // And the marker is read LAST, which is why the sentence lists it last: a
    // plan carrying both resolves to its spec, and only a plan with no spec
    // evidence at all has none.
    const bothMarkerAndSpec = [
      "# Plan 042 — lineage",
      "",
      "> Standalone: conversacion del host",
      "",
      "## Origin",
      "Spec 033",
      "",
    ].join("\n");
    expect(parseSpecRelation(bothMarkerAndSpec)).toEqual({
      status: "declared",
      number: "033",
      evidence: "spec-reference",
    });
    const standalone = [
      "# Plan 043 — lineage",
      "",
      "> Standalone: conversacion del host",
      "",
      "## Origin",
      "adopted from host conversation",
      "",
    ].join("\n");
    expect(parseSpecRelation(standalone)).toEqual({ status: "standalone" });

    const reads = await read("loops/plan-exec-loop/LOOP.md");
    expect(reads).toContain(
      "**and its source spec** (from its `> Derived from`, else one in `## Origin`; none if `> Standalone:`)",
    );
    expect(reads).not.toContain("resolved through the plan's `## Origin`");
  });
});

describe("doctrine altitude — the LEVEL of a criteria section is contract too", () => {
  it("a checklist nested under `### Acceptance criteria` is neither sealed nor addressable, and the doctrine says so", async () => {
    // The seal and the harvester both read H2 only. A spec that nests its
    // criteria under another `##` therefore reseals the same digest while its
    // promise is rewritten, and every plan derived from it stays `aligned`;
    // in the same stroke no `AC-nn` of that spec can be amended by a decision
    // note. The level was load-bearing and no document said it.
    const nested = [
      "# Spec 099 — nivel",
      "",
      "## Requirement",
      "el precio se muestra al usuario",
      "",
      "## Contract",
      "",
      "### Acceptance criteria",
      "- [ ] AC-01: el precio se redondea a 2 decimales",
      "",
    ].join("\n");
    const rewritten = nested.replace("se redondea a 2 decimales", "se TRUNCA y se cobra el doble");
    expect(functionalSpecDigest(rewritten)).toBe(functionalSpecDigest(nested));
    expect(parseSpecCriteria(nested, "099")).toEqual([]);

    const loop = await read("loops/spec-refine-loop/LOOP.md");
    expect(loop).toContain("only under a `##` heading");
    expect(loop).toContain("a nested `### Acceptance criteria` neither seals nor is addressable");
  });
});
