import { addSource } from "../../application/source-add-service.js";
import type { CliCommand } from "../registry.js";
import { fail } from "../render.js";

export const addSourceCommand: CliCommand = {
  name: "add-source",
  flags: { known: ["working-branch"] },
  describe:
    "Declare or update one source without removing any other: aw add-source <alias>:<ruta>[:<rama>] [--working-branch <rama>].",
  async execute(args, ctx) {
    const coordinate = args.rest[0];
    if (!coordinate || args.rest.length !== 1)
      return fail(
        "INVALID_INPUT",
        "Uso: aw add-source <alias>:<ruta>[:<rama>] [--working-branch <rama>]",
      );
    const first = coordinate.indexOf(":");
    if (first < 1) return fail("INVALID_INPUT", "Se requiere alias:ruta[:rama]");
    const alias = coordinate.slice(0, first);
    if (!/^[A-Za-z0-9._-]+$/.test(alias) || alias === ".." || alias === ".")
      return fail("INVALID_INPUT", `alias de fuente inválido: ${alias}`);
    const rest = coordinate.slice(first + 1);
    // A Windows drive letter belongs to the path, not to the optional branch.
    const branchSeparator = rest.lastIndexOf(":");
    const isDrive = /^[A-Za-z]:[\\/]/.test(rest);
    const hasBranch = branchSeparator >= (isDrive ? 2 : 0);
    const path = hasBranch ? rest.slice(0, branchSeparator) : rest;
    const mainBranch = hasBranch ? rest.slice(branchSeparator + 1) : undefined;
    const workingBranch = args.values.get("working-branch");
    if (!path || (hasBranch && !mainBranch))
      return fail("INVALID_INPUT", "Se requiere ruta y rama principal válida");
    const result = await addSource(ctx.fs, ctx.env, ctx.git, ctx.paths, {
      alias,
      path,
      ...(mainBranch !== undefined ? { mainBranch } : {}),
      ...(workingBranch !== undefined ? { workingBranch } : {}),
    });
    if ("error" in result) return fail("INVALID_INPUT", result.error);
    return { ok: true, data: result, exitCode: 0 };
  },
};
