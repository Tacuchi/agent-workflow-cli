import { join } from "node:path";
import { DEFAULT_CORE_DOCS_CANON } from "../domain/docs-canon.js";
import type { SessionCustody } from "../domain/session/custody.js";
import { type WorklineNodeId, formatNodeId, nodeFromDocPath } from "../domain/workline-node.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { expectedWorkBranch } from "./branch-resolver.js";
import type { ParsedProjectBlock, ProjectFuente } from "./parsers/project-block.js";
import { parseDerivedFromPath } from "./parsers/spec-relation.js";
import type { PathsService } from "./paths-service.js";
import { readCustody } from "./session-custody-service.js";

export interface DocBranchEvent {
  version: 1;
  at: string;
  doc: WorklineNodeId;
  source: string;
  branch: string;
  by: string;
  outcome: "existing" | "tracked" | "created";
}

export interface DocBranchRead {
  events: DocBranchEvent[];
  unreadable: number;
}

export function docBranchLedgerPath(paths: PathsService): string {
  return join(paths.cwdRoot(), "doc-branches.jsonl");
}

export async function readDocBranches(
  fs: FileSystemPort,
  paths: PathsService,
): Promise<DocBranchRead> {
  const path = docBranchLedgerPath(paths);
  if (!(await fs.exists(path))) return { events: [], unreadable: 0 };
  const events: DocBranchEvent[] = [];
  let unreadable = 0;
  for (const line of (await fs.readText(path)).split("\n")) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (!isEvent(value)) {
        unreadable += 1;
      } else {
        events.push(value);
      }
    } catch {
      unreadable += 1;
    }
  }
  return { events, unreadable };
}

function isEvent(value: unknown): value is DocBranchEvent {
  if (value === null || typeof value !== "object") return false;
  const event = value as Partial<DocBranchEvent>;
  const doc = event.doc;
  return (
    event.version === 1 &&
    typeof event.at === "string" &&
    typeof event.source === "string" &&
    typeof event.branch === "string" &&
    typeof event.by === "string" &&
    (event.outcome === "existing" || event.outcome === "tracked" || event.outcome === "created") &&
    doc !== null &&
    typeof doc === "object" &&
    (doc?.kind === "spec" || doc?.kind === "plan" || doc?.kind === "quick") &&
    typeof doc.key === "string" &&
    doc.key.length > 0
  );
}

export async function appendDocBranch(
  fs: FileSystemPort,
  paths: PathsService,
  event: DocBranchEvent,
): Promise<void> {
  await fs.appendText(docBranchLedgerPath(paths), `${JSON.stringify(event)}\n`);
}

export function ownDocBranch(
  read: DocBranchRead,
  doc: WorklineNodeId,
  source: string,
): string | null {
  for (let index = read.events.length - 1; index >= 0; index -= 1) {
    const event = read.events[index];
    if (event?.source === source && formatNodeId(event.doc) === formatNodeId(doc))
      return event.branch;
  }
  return null;
}

export type DocIdentity =
  | { status: "resolved"; doc: WorklineNodeId; path: string | null }
  | { status: "none" }
  | { status: "unreadable"; reason: string };

/** Custody, not a session's name, decides which document the session works on. */
export async function documentOfSession(
  fs: FileSystemPort,
  paths: PathsService,
  session: string,
): Promise<DocIdentity> {
  const read = await readCustody(fs, join(paths.cwdSessionsDir(), session));
  if (read.status === "unreadable") return { status: "unreadable", reason: read.reason };
  if (read.status === "absent") return { status: "none" };
  return documentFromCustody(read.custody, session);
}

function documentFromCustody(custody: SessionCustody, session: string): DocIdentity {
  const doc =
    custody.parents.find((p) => p.kind === "plan") ??
    custody.parents.find((p) => p.kind === "spec");
  if (doc) {
    const path =
      custody.artifacts.find((a) => {
        const found = nodeFromDocPath(a.path);
        return found && formatNodeId(found) === formatNodeId(doc);
      })?.path ?? null;
    return { status: "resolved", doc, path };
  }
  if (session.endsWith("-quick")) {
    return { status: "resolved", doc: { kind: "quick", key: session }, path: null };
  }
  return { status: "none" };
}

export interface EffectiveDocBranch {
  branch: string | null;
  origin: "own" | "inherited" | "registered" | "none" | "unreadable";
  own: string | null;
  doc: WorklineNodeId | null;
  reason?: string;
  inherited_from?: string;
  unreadable_lines: number;
}

/** Resolve a document's own branch, its spec's branch, then the registered default. */
export async function resolveDocBranch(
  fs: FileSystemPort,
  paths: PathsService,
  source: ProjectFuente,
  block: ParsedProjectBlock | null,
  identity: DocIdentity,
  provided?: DocBranchRead,
): Promise<EffectiveDocBranch> {
  const read = provided ?? (await readDocBranches(fs, paths));
  const registered = expectedWorkBranch(source, block?.working_branches ?? {});
  const base = {
    own: null,
    doc: identity.status === "resolved" ? identity.doc : null,
    unreadable_lines: read.unreadable,
  };
  if (identity.status === "unreadable") {
    return { ...base, branch: null, origin: "unreadable", reason: identity.reason };
  }
  if (identity.status === "resolved") {
    const own = ownDocBranch(read, identity.doc, source.alias);
    if (own !== null) return { ...base, own, branch: own, origin: "own" };
    const inherited = await inheritedDocBranch(fs, paths, source, identity, read, registered, base);
    if (inherited !== null) return inherited;
  }
  return { ...base, branch: registered, origin: registered === null ? "none" : "registered" };
}

export async function findDocument(
  fs: FileSystemPort,
  paths: PathsService,
  doc: WorklineNodeId,
): Promise<string | null> {
  if (doc.kind !== "plan" && doc.kind !== "spec") return null;
  const directory = DEFAULT_CORE_DOCS_CANON[doc.kind];
  const entries = await fs.list(join(paths.workspaceDir(), directory));
  const file = entries.find(
    (entry) =>
      entry.type === "file" &&
      entry.name.startsWith(`${doc.key}-${doc.kind}-`) &&
      entry.name.endsWith(".md"),
  );
  return file ? `${directory}/${file.name}` : null;
}

async function inheritedDocBranch(
  fs: FileSystemPort,
  paths: PathsService,
  source: ProjectFuente,
  identity: Extract<DocIdentity, { status: "resolved" }>,
  read: DocBranchRead,
  registered: string | null,
  base: Pick<EffectiveDocBranch, "own" | "doc" | "unreadable_lines">,
): Promise<EffectiveDocBranch | null> {
  if (identity.doc.kind !== "plan") return null;
  const path = identity.path ?? (await findDocument(fs, paths, identity.doc));
  if (path === null) return null;
  const plan = await fs.readText(join(paths.workspaceDir(), path));
  const specPath = parseDerivedFromPath(plan);
  const specExists = specPath !== null && (await fs.exists(join(paths.workspaceDir(), specPath)));
  if (specExists && specPath !== null) {
    const spec = nodeFromDocPath(specPath);
    if (spec?.kind === "spec") {
      const inherited = ownDocBranch(read, spec, source.alias);
      if (inherited !== null) {
        return {
          ...base,
          branch: inherited,
          origin: "inherited",
          inherited_from: formatNodeId(spec),
        };
      }
    }
  }
  if (specPath !== null && !specExists) {
    return {
      ...base,
      branch: registered,
      origin: registered === null ? "none" : "registered",
      reason: `no se resolvió la spec '${specPath}' para heredar su rama`,
    };
  }
  return null;
}
