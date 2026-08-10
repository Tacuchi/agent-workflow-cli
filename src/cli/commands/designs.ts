import {
  type DesignGateReport,
  gatePlanDesign,
} from "../../application/design/design-gate-service.js";
import {
  type DesignIndex,
  readDesignIndex,
  resolveDesignPackage,
} from "../../application/design/design-index-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { HumanRenderContext, QtcCommand } from "../registry.js";
import { fail } from "../render.js";
import type { CliContext } from "../types.js";

type DesignsOutput =
  | DesignIndex
  | { package: NonNullable<ReturnType<typeof resolveDesignPackage>> }
  | DesignGateReport;

export const designsCommand: QtcCommand<DesignsOutput> = {
  name: "designs",
  describe:
    "List the UI Design Packages under docs/designs/, resolve one by identity, or run " +
    "the plan-exec precondition gate over a plan. Resolution goes through the manifest " +
    "id, never the folder: a renamed or moved package still resolves. Usage: aw designs " +
    "[--id DES-NNN] [--plan docs/plans/PPP-plan-<slug>.md] [--require-approval].",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult<DesignsOutput>> {
    const plan = args.values.get("plan");
    if (plan !== undefined) return gate(plan, args, ctx);

    const index = await readDesignIndex(ctx.fs, ctx.paths.workspaceDir());
    const id = args.values.get("id");
    if (id === undefined) {
      // The listing answers "what exists and where"; the whole catalog of every
      // package would drown that. `--id` keeps it, because that IS the detail view.
      const packages = index.packages.map((p) => ({ ...p, manifest: null }));
      return { ok: true, data: { ...index, packages }, exitCode: 0 };
    }

    const found = resolveDesignPackage(index, id);
    if (found === null) {
      return fail("DESIGN_PACKAGE_NOT_FOUND", `no hay ningún package con identidad ${id}`, {
        action: `revisá 'aw designs' para ver las identidades publicadas bajo ${index.root}/`,
      } as unknown as DesignsOutput);
    }
    return { ok: true, data: { package: found }, exitCode: 0 };
  },

  renderHuman(result: CommandResult<DesignsOutput>, context: HumanRenderContext): string {
    const data = result.data;
    if (data !== undefined && "verdicts" in data) return renderGate(data);
    if (data === undefined || !("packages" in data)) return `${JSON.stringify(data, null, 2)}\n`;
    if (data.packages.length === 0) return `Sin packages de diseño bajo ${data.root}/.\n`;

    const lines = data.packages.map((pkg) => {
      const baseline =
        pkg.current_baseline === null ? "sin baseline" : `@r${pkg.current_baseline.revision}`;
      const identity = pkg.id ?? "(sin identidad)";
      // The mode decides how the entry is consumed — by its root or by an
      // artifact — so it belongs on the listing line and not behind `--detail`.
      const mode = pkg.mode === null ? "?" : pkg.mode;
      const head = `${identity}  ${mode}  ${baseline}  ${pkg.path}`;
      if (pkg.ok || !context.detail) return head;
      return [
        head,
        ...pkg.failures.map((f) => `    ✗ ${f.artifact}: ${f.message} → ${f.action}`),
      ].join("\n");
    });

    const broken = data.packages.filter((p) => !p.ok).length;
    const footer: string[] = [];
    // El diagnóstico ya está arriba cuando --detail está puesto: repetir el
    // consejo de usarlo sería decirle al usuario que haga lo que ya hizo.
    if (broken > 0 && !context.detail)
      footer.push(`${broken} package(s) sin validar — corré con --detail para el diagnóstico.`);
    for (const failure of data.failures)
      footer.push(`✗ ${failure.message} (${failure.artifact}) → ${failure.action}`);

    const body = [...lines, ...(footer.length > 0 ? ["", ...footer] : [])].join("\n");
    return `${body.trimEnd()}\n`;
  },
};

/**
 * The precondition gate as a command result.
 *
 * A blocked gate is `ok:false` on purpose: fail-closed only helps if the exit
 * code says "do not implement this". The whole report travels in `data`, and
 * `action` carries every blocking cause — the failure projection is the only one
 * the host renders for `ok:false`, so a summary line there would drop exactly
 * the artifact-and-action the gate exists to hand over.
 */
async function gate(
  plan: string,
  args: ParsedArgs,
  ctx: CliContext,
): Promise<CommandResult<DesignsOutput>> {
  const report = await gatePlanDesign(ctx.fs, ctx.paths.workspaceDir(), plan, {
    requireApproval: args.flags.has("--require-approval"),
  });
  if (!report.blocked) return { ok: true, data: report, exitCode: 0 };

  const blocking = report.verdicts
    .filter((v) => !v.ready)
    .flatMap((v) => v.failures.map((f) => ({ owner: v.owner.label, failure: f })))
    .concat(report.failures.map((f) => ({ owner: plan, failure: f })));

  return fail(
    blocking[0]?.failure.code ?? "DESIGN_GATE_BLOCKED",
    `${plan}: ${blocking.length} referencia(s) de diseño bloquean la ejecución`,
    {
      ...report,
      action: [
        ...blocking.map(
          ({ owner, failure }) =>
            `[${owner}] ${failure.code}: ${failure.message}\n  → ${failure.action}`,
        ),
        "No implementes estas tareas. plan-exec no rediseña — la corrección va a PLAN REFINE (o a SPEC REFINE si cambia comportamiento o aceptación).",
      ].join("\n"),
    } as DesignsOutput,
  );
}

/**
 * The GREEN gate. A blocked one never reaches here — the host renders `ok:false`
 * through the failure projection — so this says what a passing gate has to say:
 * which references were checked, and every warning that does not stop the work.
 */
function renderGate(report: DesignGateReport): string {
  if (report.verdicts.length === 0) {
    return `${report.plan} — sin diseño referenciado: el gate no aplica.\n`;
  }

  const pinned = report.declared.map((d) => `${d.baseline.package}@r${d.baseline.revision}`);
  const lines = [
    `${report.plan} — ${report.verdicts.length} referencia(s) de tarea · declara ${pinned.join(", ") || "(ninguna)"}`,
    "",
  ];
  for (const verdict of report.verdicts) {
    lines.push(`  ✓ ${verdict.owner.label}  ${verdict.raw}`);
    for (const notice of verdict.notices) lines.push(`      ⚠ ${notice}`);
  }
  lines.push("", "Todas las referencias resuelven en 'handoff': podés implementar.");
  return `${lines.join("\n").trimEnd()}\n`;
}
