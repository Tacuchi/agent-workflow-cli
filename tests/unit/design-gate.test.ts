import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type DesignGateReport,
  gatePlanDesign,
} from "../../src/application/design/design-gate-service.js";
import { PathsService } from "../../src/application/paths-service.js";
import { designsCommand } from "../../src/cli/commands/designs.js";
import { parseArgv } from "../../src/cli/parser.js";
import { renderHumanError } from "../../src/cli/render.js";
import type { CliContext } from "../../src/cli/types.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { MemFs } from "../helpers/mem-fs.js";

/**
 * The `plan-exec` precondition gate: what blocks, what only warns.
 *
 * The four blocking causes and the one warning cause are the phase proof, and
 * each assertion checks the ARTIFACT and the CORRECTIVE ACTION — a fail-closed
 * gate that says "no" without saying which file to fix and what to do about it
 * only moves the dead end one step later.
 */

const WS = "/ws";
const FOLDER = "docs/designs/001-design-alta";
const PLAN = "docs/plans/012-plan-alta.md";

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../fixtures/design/${name}`, import.meta.url)), "utf8");

const DIGEST_R1 = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const DIGEST_R2 = "sha256:2222222222222222222222222222222222222222222222222222222222222222";

type Json = Record<string, unknown>;

/**
 * The maximal manifest, minus the two governance entries it indexes.
 *
 * They are removed by default on purpose: `governance` is what decides whether a
 * revision may be executed, so a test about revocation must PLANT it rather than
 * inherit it, or every other case would silently depend on a file it never
 * mentions.
 */
function manifest(patch: (m: Json) => void = () => {}): string {
  const m = JSON.parse(fixture("manifest-maximal.json")) as Json;
  m.governance = { reviews: [], revocations: [] };
  patch(m);
  return JSON.stringify(m, null, 2);
}

function catalogOf(m: Json): Record<string, Array<Record<string, unknown>>> {
  return m.catalog as Record<string, Array<Record<string, unknown>>>;
}

/** The three lines a plan carries, plus the roots its tasks pin. */
function planDoc(options: {
  baseline?: string;
  digest?: string;
  hint?: string;
  roots?: string[];
}): string {
  const baseline = options.baseline ?? "DES-001@r2";
  const revision = baseline.split("@r")[1] ?? "2";
  return [
    "# Plan 012 — alta",
    "",
    "## Design references",
    "",
    `- package: \`${baseline}\``,
    `  baseline_hint: \`${options.hint ?? `${FOLDER}/baselines/DES-001-r00${revision}.json`}\``,
    `  digest: \`${options.digest ?? (revision === "1" ? DIGEST_R1 : DIGEST_R2)}\``,
    "",
    "## Tasks",
    "",
    "### F1 — el alta",
    "",
    ...(options.roots ?? [`${baseline} / SCR-001@r1#default`]).map(
      (root, i) => `- [ ] T1.${i + 1} — implementar · ${root}`,
    ),
    "",
  ].join("\n");
}

interface Options {
  manifest?: string;
  plan?: string;
  folder?: string;
  /** Governance record files to plant, package-relative. */
  records?: Record<string, string>;
}

function workspace(options: Options = {}): MemFs {
  const folder = options.folder ?? FOLDER;
  const fs = new MemFs()
    .file(`${WS}/${folder}/design-manifest.json`, options.manifest ?? manifest())
    .file(`${WS}/${folder}/baselines/DES-001-r001.json`, "{}")
    .file(`${WS}/${folder}/baselines/DES-001-r002.json`, fixture("baseline-DES-001-r002.json"))
    .file(
      `${WS}/${folder}/flows/FLW-001-r002-alta-miembro.md`,
      fixture("FLW-001-r002-alta-miembro.md"),
    )
    // The catalog publishes SCR-001 at r1, so the document has to BE r1 — and a
    // first revision supersedes nothing, or it would declare itself its own parent.
    .file(
      `${WS}/${folder}/screens/SCR-001-r001-formulario-alta.md`,
      fixture("SCR-001-r002-formulario-alta.md")
        .replace("revision: 2", "revision: 1")
        .replace("supersedes: DES-001/SCR-001@r1", "supersedes: null"),
    )
    .file(`${WS}/${PLAN}`, options.plan ?? planDoc({}));
  for (const [path, content] of Object.entries(options.records ?? {})) {
    fs.file(`${WS}/${folder}/${path}`, content);
  }
  return fs;
}

async function gate(options: Options = {}, requireApproval = false): Promise<DesignGateReport> {
  return gatePlanDesign(workspace(options), WS, PLAN, { requireApproval });
}

/** Every failure the report carries, whatever level it sits at. */
function failures(report: DesignGateReport) {
  return [...report.failures, ...report.verdicts.flatMap((v) => v.failures)];
}

const notices = (report: DesignGateReport): string =>
  report.verdicts.flatMap((v) => v.notices).join(" | ");

describe("gate de precondición — la referencia que sí resuelve", () => {
  it("una raíz en handoff cuya clausura está completa no bloquea", async () => {
    const report = await gate();
    expect(failures(report)).toEqual([]);
    expect(report.blocked).toBe(false);
    expect(report.verdicts).toHaveLength(1);
    expect(report.verdicts[0]?.ready).toBe(true);
  });

  it("atribuye la referencia a la TAREA que la fijó, con su línea", async () => {
    const report = await gate();
    expect(report.verdicts[0]?.owner).toMatchObject({ kind: "task", label: "T1.1" });
    expect(report.verdicts[0]?.owner.line).toBeGreaterThan(0);
  });

  it("una referencia en prosa se atribuye al documento y no repite su nombre", async () => {
    // Un plan que HABLA de referencias (como el 012 mismo) las trae en prosa,
    // fuera de toda tarea. Nombrar el plan dos veces leía como dos artefactos.
    const report = await gate({
      plan: "# Plan\n\nejemplo: DES-001@r2 / SCR-001@r1#default\n\n## Tasks\n\n- [ ] T1.1 — algo\n",
    });
    const [failure] = failures(report);
    expect(report.verdicts[0]?.owner.kind).toBe("document");
    expect(failure?.artifact).toBe(PLAN);
  });

  it("un plan sin diseño no es un plan bloqueado: el gate no aplica", async () => {
    const report = await gate({ plan: "# Plan\n\n## Tasks\n\n- [ ] T1.1 — algo\n" });
    expect(report.blocked).toBe(false);
    expect(report.verdicts).toEqual([]);
    expect(report.declared).toEqual([]);
  });
});

describe("gate de precondición — las cuatro causas de bloqueo", () => {
  it("1. ausencia: la revisión no está en el catálogo", async () => {
    const report = await gate({ plan: planDoc({ roots: ["DES-001@r2 / SCR-009@r1"] }) });
    const [failure] = failures(report);
    expect(report.blocked).toBe(true);
    expect(failure?.code).toBe("DESIGN_REFERENCE_MISSING");
    expect(failure?.artifact).toContain(PLAN);
    expect(failure?.message).toContain("SCR-009@r1");
    expect(failure?.action).toContain("publicá");
  });

  it("2. digest distinto: la referencia fija bytes que ya no son esos", async () => {
    const report = await gate({
      plan: planDoc({ digest: `sha256:${"9".repeat(64)}` }),
    });
    const [failure] = failures(report);
    expect(report.blocked).toBe(true);
    expect(failure?.code).toBe("DESIGN_REFERENCE_DIGEST_MISMATCH");
    expect(failure?.message).toContain(DIGEST_R2);
    expect(failure?.action).toContain("creá la siguiente");
  });

  it("3. revocación: la única prohibición explícita", async () => {
    const report = await gate({
      manifest: manifest((m) => {
        m.governance = {
          reviews: [],
          revocations: [
            {
              id: "RVK-001",
              path: "governance/revocations/RVK-001.json",
              digest: `sha256:${"4".repeat(64)}`,
              target: "DES-001@r2",
            },
          ],
        };
      }),
      records: { "governance/revocations/RVK-001.json": fixture("RVK-001-bloqueo.json") },
    });
    const [failure] = failures(report);
    expect(report.blocked).toBe(true);
    expect(failure?.code).toBe("DESIGN_REVISION_REVOKED");
    expect(failure?.message).toContain("DES-001@r2");
    expect(failure?.action).toContain("usá otra revisión");
  });

  it("4. handoff incompleto: la clausura alcanza una revisión en outline", async () => {
    const report = await gate({
      manifest: manifest((m) => {
        const screen = catalogOf(m).screens[0] as Record<string, unknown>;
        screen.maturity = "outline";
      }),
      plan: planDoc({ roots: ["DES-001@r2 / SCR-001@r1"] }),
    });
    const [failure] = failures(report);
    expect(report.blocked).toBe(true);
    expect(failure?.code).toBe("DESIGN_HANDOFF_INCOMPLETE");
    expect(failure?.message).toContain("DES-001/SCR-001@r1");
    expect(failure?.action).toContain("PLAN REFINE");
    expect(failure?.action).toContain("no rediseña");
  });

  it("un package nombrado sin fijar revisión se reporta, no se adivina", async () => {
    // Sin ninguna raíz que lo fije: nombrarlo en prosa Y fijarlo en otra tarea
    // del mismo documento es legítimo, y el contrato lo exime a propósito.
    const report = await gate({
      plan: "# Plan\n\n## Tasks\n\n### F1 — el alta\n\n- [ ] T1.1 — mirar DES-001 y seguir\n",
    });
    expect(report.blocked).toBe(true);
    expect(failures(report).some((f) => f.code === "DESIGN_REFERENCE_APPROXIMATE")).toBe(true);
  });

  it("el bloqueo alcanza a TODO el plan, no solo a la tarea culpable", async () => {
    const report = await gate({
      plan: planDoc({ roots: ["DES-001@r2 / SCR-001@r1", "DES-001@r2 / SCR-009@r1"] }),
    });
    expect(report.verdicts.map((v) => v.ready)).toEqual([true, false]);
    expect(report.blocked).toBe(true);
  });
});

describe("gate de precondición — lo que solo avisa", () => {
  it("superseded pero íntegra sigue ejecutable, y lo dice", async () => {
    const report = await gate({
      plan: planDoc({ baseline: "DES-001@r1", roots: ["DES-001@r1 / SCR-001@r1"] }),
    });
    expect(failures(report)).toEqual([]);
    expect(report.blocked).toBe(false);
    expect(notices(report)).toContain("superseded");
    expect(notices(report)).toContain("sigue ejecutable");
  });

  it("un hint viejo tras renombrar el dossier avisa y conserva la validez", async () => {
    const report = await gate({ folder: "docs/designs/042-design-altas-y-bajas" });
    expect(report.blocked).toBe(false);
    expect(notices(report)).toContain("baseline_hint");
    expect(notices(report)).toContain("042-design-altas-y-bajas");
  });

  it("el aviso NO es un fallo: publicar r2 no invalida el r1 que alguien fijó", async () => {
    const report = await gate({
      plan: planDoc({ baseline: "DES-001@r1", roots: ["DES-001@r1 / SCR-001@r1"] }),
    });
    expect(report.verdicts[0]?.ready).toBe(true);
    expect(report.verdicts[0]?.failures).toEqual([]);
  });
});

describe("política de aprobación del workspace", () => {
  const approved = {
    manifest: manifest((m) => {
      m.governance = {
        reviews: [
          {
            id: "REV-001",
            path: "governance/reviews/REV-001.json",
            digest: `sha256:${"3".repeat(64)}`,
            target: "DES-001@r2",
          },
        ],
        revocations: [],
      };
    }),
    records: { "governance/reviews/REV-001.json": fixture("REV-001-approved.json") },
  };

  it("desactivada por defecto: sin record, ejecuta igual", async () => {
    expect((await gate()).blocked).toBe(false);
  });

  it("activada sin record aprobado bloquea, y la aprobación no se hereda", async () => {
    const report = await gate({}, true);
    const [failure] = failures(report);
    expect(report.blocked).toBe(true);
    expect(failure?.code).toBe("DESIGN_APPROVAL_MISSING");
    expect(failure?.action).toContain("no se hereda");
  });

  it("activada con el record que aprueba ESE baseline exacto, ejecuta", async () => {
    expect((await gate(approved, true)).blocked).toBe(false);
  });

  it("un record inválido no aprueba nada: no es una decisión registrada", async () => {
    const report = await gate(
      {
        ...approved,
        records: {
          "governance/reviews/REV-001.json": JSON.stringify({
            ...(JSON.parse(fixture("REV-001-approved.json")) as Json),
            decision: "rejected",
          }),
        },
      },
      true,
    );
    expect(report.blocked).toBe(true);
    expect(failures(report)[0]?.code).toBe("DESIGN_APPROVAL_MISSING");
  });
});

describe("aw designs --plan — el veredicto como resultado de comando", () => {
  function context(fs: MemFs): CliContext {
    const env = new FakeEnv("/home/u", WS);
    return { fs, env, paths: new PathsService("workflow", "/home/u", WS) } as unknown as CliContext;
  }

  async function run(options: Options, argv: string[] = []) {
    return designsCommand.execute(
      parseArgv(["designs", "--plan", PLAN, ...argv]),
      context(workspace(options)),
    );
  }

  it("verde: ok y exit 0", async () => {
    const result = await run({});
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it("bloqueado: exit distinto de cero, porque fail-closed sirve al que lo invoca", async () => {
    const result = await run({ plan: planDoc({ roots: ["DES-001@r2 / SCR-009@r1"] }) });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.error?.code).toBe("DESIGN_REFERENCE_MISSING");
  });

  it("la salida humana del bloqueo nombra artefacto, acción y que no se rediseña", async () => {
    // Por la MISMA ruta que usa el host: con `ok:false` nunca llama a
    // `renderHuman`, así que aseverar sobre esa proyección probaría código muerto.
    const result = await run({ plan: planDoc({ roots: ["DES-001@r2 / SCR-009@r1"] }) });
    const text = renderHumanError(result.error, result.data);
    expect(text).toContain("DESIGN_REFERENCE_MISSING");
    expect(text).toContain("[T1.1]");
    expect(text).toContain("SCR-009@r1");
    expect(text).toContain("→ ");
    expect(text).toContain("PLAN REFINE");
    expect(text.endsWith("\n")).toBe(true);
  });

  it("la salida humana del verde lista lo comprobado y sus avisos", async () => {
    const result = await run({
      plan: planDoc({ baseline: "DES-001@r1", roots: ["DES-001@r1 / SCR-001@r1"] }),
    });
    const text = designsCommand.renderHuman?.(result, { detail: false }) ?? "";
    expect(text).toContain("✓ T1.1");
    expect(text).toContain("⚠ ");
    expect(text).toContain("superseded");
    expect(text).toContain("podés implementar");
  });

  it("y un plan sin diseño lo dice en vez de listar cero referencias", async () => {
    const result = await run({ plan: "# Plan\n\n## Tasks\n\n- [ ] T1.1 — algo\n" });
    const text = designsCommand.renderHuman?.(result, { detail: false }) ?? "";
    expect(text).toContain("el gate no aplica");
  });

  it("--require-approval llega como bandera y no se come el path del plan", async () => {
    const args = parseArgv(["designs", "--require-approval", "--plan", PLAN]);
    expect(args.flags.has("--require-approval")).toBe(true);
    expect(args.values.get("plan")).toBe(PLAN);
  });

  it("un plan que no existe se dice como tal, no como diseño ausente", async () => {
    const report = await gatePlanDesign(workspace(), WS, "docs/plans/999-fantasma.md");
    expect(report.blocked).toBe(true);
    expect(failures(report)[0]?.code).toBe("DESIGN_GATE_PLAN_MISSING");
  });
});
