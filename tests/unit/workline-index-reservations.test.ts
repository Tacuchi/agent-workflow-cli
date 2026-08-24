import { describe, expect, it } from "vitest";
import { PathsService } from "../../src/application/paths-service.js";
import { runStatusCommand } from "../../src/application/status-service.js";
import { buildWorklineIndex } from "../../src/application/workline-index-service.js";
import { statusCommand } from "../../src/cli/commands/status.js";
import { reservationMarker } from "../../src/domain/reservation.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { MemFs } from "../helpers/mem-fs.js";

/**
 * The board used to offer a reservation as an executable plan.
 *
 * Reproduced live while this very plan was being written: `docs/plans/036-...md`
 * held nothing but `<!-- aw:reserva 145-... -->`, and `aw status` reported it with
 * `plan_state: "open"` and a pipeline row whose command was
 * `/w:plan-exec docs/plans/036-...md` — inviting somebody to execute a document
 * that did not exist yet. It was NOT only the anonymous legacy placeholder: a
 * marker with a perfectly valid owner did it too. That reproduction is this test.
 */

const NOW = new Date(2026, 7, 24, 12, 0, 0);
const OWNER = "145-claims-con-propietario-plan-new";

const paths = (): PathsService => new PathsService(normalizeNamespace("workflow"), "/home", "/cwd");
const index = (fs: MemFs) =>
  buildWorklineIndex(fs, new FakeEnv("/home", "/cwd"), paths(), { now: NOW });

const workspace = (): MemFs =>
  new MemFs({ lenient: true })
    .file("/cwd/CLAUDE.md", "# Proyecto\n\n## Fuentes\n\n| Alias | Path | Rama |\n")
    .dir("/cwd/.workflow/sessions")
    .dir("/cwd/docs/specs")
    .dir("/cwd/docs/plans");

describe("el tablero distingue reserva, documento y placeholder legacy", () => {
  it("una reserva con dueño válido NO es un plan y NO se ofrece como ejecutable", async () => {
    const fs = workspace()
      .file("/cwd/docs/plans/036-plan-claims-con-propietario.md", reservationMarker(OWNER))
      .file(
        "/cwd/docs/plans/034-plan-real.md",
        "# Plan 034 — real\n\n> Estado: open\n\n## Tasks\n\n### F1 — algo\n> Estado: pendiente\n",
      );

    const result = await index(fs);

    // Fuera del corpus: sólo el plan de verdad se cuenta.
    expect(result.plans.map((p) => p.number)).toEqual(["034"]);
    // Y fuera del pipeline: nadie debería ver `/w:plan-exec` sobre una reserva.
    const commands = result.pipeline.map((item) => item.command).join(" | ");
    expect(commands).not.toContain("036-plan-claims-con-propietario");
    // Presente como lo que es, con su dueño y su acción sancionada.
    expect(result.reservations).toHaveLength(1);
    expect(result.reservations[0]).toMatchObject({
      file: "docs/plans/036-plan-claims-con-propietario.md",
      kind: "reservation",
      correlative: "036",
      owner: OWNER,
      intact: true,
      revoked: false,
      next: "aw claims recover docs/plans/036-plan-claims-con-propietario.md",
    });
  });

  it("un numerado vacío sin dueño es un placeholder legacy ambiguo, no un documento", async () => {
    const fs = workspace().file("/cwd/docs/specs/003-spec-vieja.md", "");

    const result = await index(fs);

    expect(result.specs).toEqual([]);
    expect(result.reservations).toHaveLength(1);
    expect(result.reservations[0]).toMatchObject({
      kind: "legacy-placeholder",
      owner: null,
      intact: false,
      // La acción sancionada lleva la confirmación en el propio comando: sus
      // bytes no prueban que nadie vaya a escribirlo.
      next: "aw claims recover docs/specs/003-spec-vieja.md --confirm-no-producer",
    });
  });

  it("un documento publicado sigue siendo un documento", async () => {
    const fs = workspace().file(
      "/cwd/docs/specs/004-spec-real.md",
      "---\nstatus: ready-for-plan\n---\n\n# Spec 004\n",
    );

    const result = await index(fs);

    expect(result.specs.map((s) => s.number)).toEqual(["004"]);
    expect(result.reservations).toEqual([]);
  });

  it("el tablero HUMANO los nombra: pasar de equivocado a mudo no era arreglarlo", async () => {
    const fs = workspace()
      .file("/cwd/docs/plans/036-plan-reservado.md", reservationMarker(OWNER))
      .file("/cwd/docs/specs/003-spec-vacia.md", "");

    const data = await runStatusCommand(fs, new FakeEnv("/home", "/cwd"), paths(), {});
    const rendered = statusCommand.renderHuman?.(
      { ok: true, data, exitCode: 0 },
      { detail: false },
    );
    if (rendered === undefined) throw new Error("esperaba una proyección humana");

    // Antes de F6 el tablero ofrecía `/w:plan-exec` sobre un marcador; después de
    // sacarlo del corpus, la vista humana no decía NADA y el único caso que pide
    // decisión de una persona —el placeholder sin dueño— no tenía rastro.
    expect(rendered).toContain("Correlativos reservados (2)");
    expect(rendered).toContain("docs/plans/036-plan-reservado.md");
    expect(rendered).toContain(OWNER);
    expect(rendered).toContain("placeholder legacy ambiguo");
    expect(rendered).toContain("--confirm-no-producer");
    expect(rendered).not.toContain("sin pendientes");
    // Y sigue sin ser trabajo ejecutable.
    expect(rendered).not.toContain("/w:plan-exec");
  });
});
