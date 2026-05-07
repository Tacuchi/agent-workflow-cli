import { createRequire } from "node:module";
import { join } from "node:path";
import type { CliContext } from "../../cli/types.js";
import type { CommandResult } from "../../domain/types.js";

export interface SelfDoctorReport {
  cli_version: string;
  namespace: { value: string; source: string };
  paths: {
    user_root: string;
    cwd_root: string;
    runtime_json: string;
  };
  runtime: {
    package_name: string;
    bin_name: string;
    source: string;
    config_path?: string;
    display_name?: string;
  };
  skill: {
    installed: boolean;
    path: string;
  };
}

export async function selfDoctor(ctx: CliContext): Promise<CommandResult<SelfDoctorReport>> {
  const skillPath = join(ctx.env.homeDir(), ".claude", "skills", "agent-workflow");
  const skillInstalled = await ctx.fs.exists(skillPath);

  return {
    ok: true,
    data: {
      cli_version: readPackageVersion(),
      namespace: {
        value: ctx.namespace.namespace,
        source: ctx.namespace.source,
      },
      paths: {
        user_root: ctx.paths.userRoot(),
        cwd_root: ctx.paths.cwdRoot(),
        runtime_json: ctx.paths.userRuntimeJson(),
      },
      runtime: {
        package_name: ctx.runtime.packageName,
        bin_name: ctx.runtime.binName,
        source: ctx.runtime.source,
        ...(ctx.runtime.configPath ? { config_path: ctx.runtime.configPath } : {}),
        ...(ctx.runtime.displayName ? { display_name: ctx.runtime.displayName } : {}),
      },
      skill: {
        installed: skillInstalled,
        path: skillPath,
      },
    },
    exitCode: 0,
  };
}

function readPackageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../../../package.json") as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}
