import { join } from "node:path";
import type { CapabilityFailure } from "../../domain/capability/protocol.js";
import type { FlowDirective } from "../../domain/flow/directive.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import type { GitPort } from "../../ports/git.js";
import type { WorklineFlow } from "../capability/compose.js";
import { type ReadSetEntry, runContextPlan } from "../context/plan-service.js";
import type { PathsService } from "../paths-service.js";
import {
  type SessionCreateRecordOutput,
  escapeRegExp,
  runSessionCreate,
} from "../session-create-service.js";
import { readSessionState, typeFromNameSuffix } from "../session-resolver.js";
import { sessionDescriptor } from "./flow-descriptor.js";
import { advanceFlow } from "./flow-service.js";
import type { InternalActionExecutor } from "./internal-actions.js";

/**
 * `aw flow start`: a run opened in ONE invocation (plan 082 F7 · spec 061 AC-10).
 *
 * It chains what the agent used to call three times — the session (created, or
 * resumed when one with the same descriptor is still active), the read-set of
 * the flow and the adoption of its run — and hands back the first directive.
 * The command's own guide is marked as already loaded, because the host loaded
 * it to get here; the manifest, and so what `context-budget` measures, is
 * unchanged.
 */
export interface FlowStartInput {
  flow: WorklineFlow;
  /** The slug; the session descriptor is `<slug>-<flow>`. */
  name: string;
  objetivo: string;
  inputs?: readonly string[];
  from?: string;
  contextId?: string;
  root?: string;
}

export interface FlowStartOutput {
  session: { folder: string; resumed: boolean; created: SessionCreateRecordOutput | null };
  read_set: (ReadSetEntry & { loaded: boolean })[];
  /** The bytes still to read: the read-set minus what the host already loaded. */
  bytes_to_read: number;
  directive: FlowDirective;
}

export async function startFlow(
  deps: { fs: FileSystemPort; rawFs?: FileSystemPort; paths: PathsService; git: GitPort },
  executor: InternalActionExecutor,
  input: FlowStartInput,
): Promise<{ ok: true; data: FlowStartOutput } | { ok: false; failure: CapabilityFailure }> {
  // The slug alone: a leading `NNN-` is the CLI's to assign and a trailing
  // `-<flow>` is this command's to add, so neither is kept twice.
  const slug = sessionDescriptor(input.name).replace(new RegExp(`-${input.flow}$`), "");
  const descriptor = `${slug}-${input.flow}`;
  const active = await activeSession(deps.fs, deps.paths, descriptor);
  let created: SessionCreateRecordOutput | null = null;
  let folder = active;
  if (folder === null) {
    const made = await createFlowSession(deps, input, descriptor);
    if ("error" in made) {
      return {
        ok: false,
        failure: {
          code: made.code ?? "INVALID_INPUT",
          message: made.error,
          action: "corregí lo que el mensaje nombra y volvé a correr aw flow start",
        },
      };
    }
    created = made.sessionCreate;
    folder = created.folder;
  }

  const plan = await runContextPlan(deps.fs, {
    command: input.flow,
    ...(input.root === undefined ? {} : { root: input.root }),
  });
  const guide = `commands/${input.flow}.md`;
  const readSet = plan.read_set.map((entry) => ({ ...entry, loaded: entry.path === guide }));

  const advanced = await advanceFlow(deps.fs, deps.paths, {
    code: folder,
    flow: input.flow,
    adopt: true,
    executor,
    git: deps.git,
    ...(input.contextId === undefined ? {} : { contextId: input.contextId }),
  });
  if (!advanced.ok) {
    return {
      ok: false,
      failure:
        "failure" in advanced
          ? advanced.failure
          : {
              code: advanced.session.code,
              message: advanced.session.message,
              action: advanced.session.action,
            },
    };
  }
  return {
    ok: true,
    data: {
      session: { folder, resumed: active !== null, created },
      read_set: readSet,
      bytes_to_read: readSet.filter((entry) => !entry.loaded).reduce((n, e) => n + e.bytes, 0),
      directive: advanced.directive,
    },
  };
}

/** The active session this descriptor already names, if one is still open. */
async function activeSession(
  fs: FileSystemPort,
  paths: PathsService,
  descriptor: string,
): Promise<string | null> {
  const root = paths.cwdSessionsDir();
  if (!(await fs.exists(root))) return null;
  const wanted = new RegExp(`^(?:session)?\\d{3,}-${escapeRegExp(descriptor)}$`);
  const names = (await fs.list(root))
    .filter((entry) => entry.type === "dir" && wanted.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  for (const name of names.reverse()) {
    if ((await readSessionState(fs, join(root, name))) === "active") return name;
  }
  return null;
}

async function createFlowSession(
  deps: Parameters<typeof startFlow>[0],
  input: FlowStartInput,
  descriptor: string,
) {
  const made = await runSessionCreate(
    deps.rawFs ?? deps.fs,
    deps.paths,
    {
      type: typeFromNameSuffix(descriptor) ?? "refine",
      name: descriptor,
      objetivo: input.objetivo,
      ...(input.from === undefined ? {} : { originRaw: input.from }),
      ...(input.inputs === undefined ? {} : { inputs: input.inputs }),
      ...(input.contextId === undefined ? {} : { contextId: input.contextId }),
    },
    deps.git,
  );
  return made;
}
