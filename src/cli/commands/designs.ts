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
  | { package: NonNullable<ReturnType<typeof resolveDesignPackage>> };

export const designsCommand: QtcCommand<DesignsOutput> = {
  name: "designs",
  describe:
    "List the UI Design Packages under docs/designs/, or resolve one by identity. " +
    "Resolution goes through the manifest id, never the folder: a renamed or moved " +
    "package still resolves. Usage: aw designs [--id DES-NNN].",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult<DesignsOutput>> {
    const index = await readDesignIndex(ctx.fs, ctx.paths.workspaceDir());
    const id = args.values.get("id");
    if (id === undefined) return { ok: true, data: index, exitCode: 0 };

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
    if (data === undefined || !("packages" in data)) return `${JSON.stringify(data, null, 2)}\n`;
    if (data.packages.length === 0) return `Sin packages de diseño bajo ${data.root}/.\n`;

    const lines = data.packages.map((pkg) => {
      const baseline =
        pkg.current_baseline === null ? "sin baseline" : `@r${pkg.current_baseline.revision}`;
      const identity = pkg.id ?? "(sin identidad)";
      const head = `${identity}  ${baseline}  ${pkg.path}`;
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
