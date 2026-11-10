import { join } from "node:path";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { approvalDigest, guardUnchanged, readDigestOf, textDigest } from "./doc-flow/doc-digest.js";
import { specStatusOf, withPlanState } from "./doc-flow/doc-flow-service.js";
import { parsePlanStatus } from "./parsers/plan-status.js";
import type { PathsService } from "./paths-service.js";
import { buildWorklineIndex } from "./workline-index-service.js";

export interface DiscardPreview {
  action: "prepare";
  kind: "spec" | "plan";
  target: string;
  from: string;
  to: "abandoned";
  /** Live plans that consume the spec: named, never touched. */
  untouched: string[];
  read_digest: string;
  digest: string;
  next: string;
}

export interface DiscardApplied {
  action: "apply";
  kind: "spec" | "plan";
  target: string;
  state: "abandoned";
  digest: string;
}

export interface DiscardFailure {
  code: string;
  message: string;
  action: string;
}

export type DiscardResult<T> = { ok: true; value: T } | { ok: false; failure: DiscardFailure };

/**
 * `aw discard` in the documents model (spec 066, D09, AC-13): the spec or plan
 * is marked `abandoned` and stays where it is, keeping its number and every
 * reference to it. Nothing else is written: not the spec a discarded plan
 * derives from, not the plans of a discarded spec.
 */
export async function prepareDiscard(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  target: string,
): Promise<DiscardResult<DiscardPreview>> {
  const located = await locate(fs, env, paths, target);
  if (!located.ok) return located;
  const { kind, file, from, untouched } = located.value;
  if (from === "abandoned") {
    return refuse(
      "DISCARD_ALREADY_ABANDONED",
      `'${file}' ya está abandoned`,
      "no hay nada que descartar",
    );
  }
  const read_digest = await readDigestOf(fs, join(paths.hubDir(), file));
  const digest = approvalDigest({ discard: file, read: read_digest });
  return {
    ok: true,
    value: {
      action: "prepare",
      kind,
      target: file,
      from,
      to: "abandoned",
      untouched,
      read_digest,
      digest,
      next: `aw discard apply ${file} --approval ${digest}`,
    },
  };
}

export async function applyDiscard(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  input: { target: string; approval: string },
): Promise<DiscardResult<DiscardApplied>> {
  const preview = await prepareDiscard(fs, env, paths, input.target);
  if (!preview.ok) return preview;
  const { kind, target, read_digest, digest } = preview.value;
  if (digest !== input.approval) {
    return refuse(
      "DOC_CHANGED_SINCE_READ",
      `'${target}' cambió desde la vista previa: la aprobación ya no vale`,
      `volvé a correr 'aw discard prepare ${target}' y aprobá su digest`,
    );
  }
  const absolute = join(paths.hubDir(), target);
  const changed = await guardUnchanged(fs, absolute, target, read_digest);
  if (changed !== null) return { ok: false, failure: changed };
  const text = await fs.readText(absolute);
  const written = kind === "plan" ? withPlanState(text, "abandoned") : withSpecAbandoned(text);
  await fs.writeText(absolute, written);
  return {
    ok: true,
    value: { action: "apply", kind, target, state: "abandoned", digest: textDigest(written) },
  };
}

async function locate(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  target: string,
): Promise<
  DiscardResult<{ kind: "spec" | "plan"; file: string; from: string; untouched: string[] }>
> {
  const index = await buildWorklineIndex(fs, env, paths);
  const [prefix, key] = target.includes(":") ? target.split(":", 2) : [null, target];
  const plan = index.plans.find(
    (item) =>
      item.file === target || ((prefix === "plan" || prefix === null) && item.number === key),
  );
  const spec = index.specs.find(
    (item) =>
      item.file === target || ((prefix === "spec" || prefix === null) && item.number === key),
  );
  if (
    plan !== undefined &&
    spec !== undefined &&
    prefix === null &&
    plan.file !== target &&
    spec.file !== target
  ) {
    return refuse(
      "DISCARD_TARGET_AMBIGUOUS",
      `'${target}' es una spec y un plan`,
      "usá spec:NNN, plan:PPP o la ruta",
    );
  }
  if (plan !== undefined && (prefix !== "spec" || plan.file === target)) {
    const text = await fs.readText(join(paths.hubDir(), plan.file));
    const status = parsePlanStatus(text);
    return {
      ok: true,
      value: {
        kind: "plan",
        file: plan.file,
        from: status.declared === "absent" ? "draft" : status.declared,
        untouched: [],
      },
    };
  }
  if (spec !== undefined) {
    const text = await fs.readText(join(paths.hubDir(), spec.file));
    const untouched = index.plans
      .filter(
        (item) =>
          item.spec.status === "resolved" &&
          item.spec.number === spec.number &&
          item.plan_state !== "abandoned",
      )
      .map((item) => item.file);
    return {
      ok: true,
      value: { kind: "spec", file: spec.file, from: specStatusOf(text), untouched },
    };
  }
  return refuse(
    "DISCARD_TARGET_ABSENT",
    `ningún documento coincide con '${target}'`,
    "pasá spec:NNN, plan:PPP o la ruta del documento bajo docs/",
  );
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/;

function withSpecAbandoned(content: string): string {
  const match = FRONTMATTER.exec(content);
  if (match === null) return `---\nstatus: abandoned\n---\n\n${content}`;
  const lines = (match[1] ?? "").split(/\r?\n/);
  const at = lines.findIndex((line) => /^status\s*:/.test(line));
  if (at >= 0) lines[at] = "status: abandoned";
  else lines.push("status: abandoned");
  return `---\n${lines.join("\n")}\n---${match[2] ?? "\n"}${content.slice(match[0].length)}`;
}

function refuse<T>(code: string, message: string, action: string): DiscardResult<T> {
  return { ok: false, failure: { code, message, action } };
}
