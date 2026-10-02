import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import type { GitPort } from "../ports/git.js";
import { hubNames, hubState, hubsFile, readHubs } from "./hub-registry.js";
import { PathsService } from "./paths-service.js";
import { resumePipeline } from "./resume-service.js";
import { type StatusOutput, statusOfIndex } from "./status-service.js";
import { buildWorklineIndex } from "./workline-index-service.js";

export type HubStatus =
  | {
      name: string;
      root: string;
      ok: true;
      pending: number;
      next: string | null;
      notices: number;
      last_activity: string | null;
    }
  | { name: string; root: string; ok: false; reason: "missing" | "not-a-hub" | "unreadable" };

export interface HubsStatusOutput {
  hubs: HubStatus[];
  counts: { hubs: number; ok: number; pending: number; notices: number };
}

export interface HubsStatusDeps {
  fs: FileSystemPort;
  env: EnvPort;
  git?: GitPort;
}

/**
 * One line per registered hub, from the same index `aw status` and `aw resume`
 * read, built once per hub. Only counts and the next command travel, so the
 * size follows the number of hubs and never their history. A hub that fails is
 * reported and the others are still computed.
 */
export async function runHubsStatus(
  deps: HubsStatusDeps,
  namespace: string,
  countNotices: (status: StatusOutput) => number,
): Promise<HubsStatusOutput> {
  const home = deps.env.homeDir();
  const roots = await readHubs(hubsFile(home, namespace));
  const names = hubNames(roots);
  const hubs: HubStatus[] = [];
  for (const root of roots) {
    const name = names.get(root) ?? root;
    // Ephemeral or not, a registered hub that exists is computed like any other.
    const state = await hubState(deps.fs, root, namespace, []);
    if (state === "missing" || state === "not-a-hub") {
      hubs.push({ name, root, ok: false, reason: state });
      continue;
    }
    hubs.push(await hubStatus(deps, namespace, home, name, root, countNotices));
  }
  const healthy = hubs.filter((hub) => hub.ok);
  return {
    hubs,
    counts: {
      hubs: hubs.length,
      ok: healthy.length,
      pending: healthy.reduce((sum, hub) => sum + hub.pending, 0),
      notices: healthy.reduce((sum, hub) => sum + hub.notices, 0),
    },
  };
}

async function hubStatus(
  deps: HubsStatusDeps,
  namespace: string,
  home: string,
  name: string,
  root: string,
  countNotices: (status: StatusOutput) => number,
): Promise<HubStatus> {
  const paths = new PathsService(namespace as PathsService["namespace"], home, root);
  try {
    const index = await buildWorklineIndex(deps.fs, deps.env, paths, {
      ...(deps.git !== undefined ? { git: deps.git } : {}),
    });
    const status = await statusOfIndex(deps.fs, paths, index);
    const resume = resumePipeline(index);
    return {
      name,
      root,
      ok: true,
      pending: status.pipeline.length,
      next:
        resume.status === "proposal"
          ? resume.proposal.command
          : resume.status === "candidates"
            ? "aw resume"
            : null,
      notices: countNotices(status),
      last_activity: status.last_activity,
    };
  } catch {
    return { name, root, ok: false, reason: "unreadable" };
  }
}
