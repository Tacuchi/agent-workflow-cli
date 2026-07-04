import { runBootstrapDsn } from "../../application/dev-bootstrap-dsn-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import { fail } from "../render.js";
import type { CliContext } from "../types.js";

export const bootstrapDsnCommand: QtcCommand = {
  name: "bootstrap-dsn",
  describe: "Persist DB_CERT_DSN/DB_PROD_DSN to the namespace's dsn.env file.",
  async execute(_args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const certDsn = ctx.env.get("DB_CERT_DSN");
    const prodDsn = ctx.env.get("DB_PROD_DSN");
    const result = runBootstrapDsn(ctx.paths, { certDsn, prodDsn });
    if ("error" in result) {
      return fail("MISSING_DSN", result.error, { error: result.error }, 2);
    }
    return { ok: true, data: result, exitCode: 0 };
  },
};
