import { join } from "node:path";
import type { FinalValidationCommand, FinalValidationSource } from "../domain/flow/run-state.js";
import type { FileSystemPort } from "../ports/file-system.js";
import {
  BLOCK_FILE,
  BLOCK_READ_FILES,
  type ParsedHubBlock,
  parseHubBlock,
} from "./parsers/hub-block.js";
import type { PathsService } from "./paths-service.js";
import { finalValidationOverrides } from "./source-boundary-policy.js";

export type PipelineValue =
  | { kind: "command"; command: string }
  | { kind: "none"; value: "ninguno" }
  | { kind: "undeclared"; action: string };

export interface SourcePipeline {
  alias: string;
  build: PipelineValue;
  test: PipelineValue;
  /** Block file from which this declaration was read. */
  origin: string;
}

export function sourcePipeline(
  block: ParsedHubBlock,
  alias: string,
  origin: string = BLOCK_FILE,
): SourcePipeline {
  const declaration = block.pipeline?.[alias];
  const value = (field: "build" | "test"): PipelineValue => {
    const command = declaration?.[field];
    if (command === undefined)
      return { kind: "undeclared", action: `aw set-pipeline ${alias} ${field} <comando|ninguno>` };
    return command === "ninguno"
      ? { kind: "none", value: "ninguno" }
      : { kind: "command", command };
  };
  return { alias, build: value("build"), test: value("test"), origin };
}

/** Pipelines come from the file the hub block is read from: AGENTS.md, else a legacy CLAUDE.md. */
export async function readSourcePipelines(
  fs: FileSystemPort,
  paths: PathsService,
): Promise<SourcePipeline[]> {
  for (const name of BLOCK_READ_FILES) {
    const file = join(paths.hubDir(), name);
    if (!(await fs.exists(file))) continue;
    const block = parseHubBlock(await fs.readText(file), paths.blockMarkers());
    if (block === null) continue;
    return block.fuentes.map(({ alias }) => sourcePipeline(block, alias, name));
  }
  return [];
}

/** A plan override is per command and per source; `ninguno` is never a runnable command. */
export function resolveFinalValidation(
  plan: string,
  aliases: readonly string[],
  pipelines: readonly SourcePipeline[],
): FinalValidationSource[] {
  const overrides = finalValidationOverrides(plan);
  return aliases
    .filter((alias) => alias !== "hub")
    .map((alias) => {
      const override = overrides.find((item) => item.alias === alias);
      const source = pipelines.find((item) => item.alias === alias);
      const command = (field: "build" | "test"): FinalValidationCommand => {
        const fromPlan = override?.[field];
        if (fromPlan !== undefined) return { command: fromPlan, origin: "plan" };
        const fromSource = source?.[field];
        if (fromSource?.kind === "command")
          return { command: fromSource.command, origin: "source" };
        return {
          command: null,
          origin: null,
          action: `declará ${field === "test" ? "tests" : "build"} para '${alias}' en el pipeline versionado de la fuente (aw set-pipeline ${alias} ${field} <comando>) o en ## Validations del plan con Validación final · \`${alias}\` · ${field === "test" ? "tests" : "build"} \`<comando>\``,
        };
      };
      return { alias, build: command("build"), test: command("test") };
    });
}
