import { basename } from "node:path";
import {
  isPlainBranchName,
  isWorkingBranch,
  resolveSourceBranches,
} from "../../application/branch-resolver.js";
import {
  type DocIdentity,
  appendDocBranch,
  documentOfSession,
  findDocument,
  ownDocBranch,
  readDocBranches,
  resolveDocBranch,
} from "../../application/doc-branch-ledger.js";
import { readWorkspaceBlock } from "../../application/parsers/project-block.js";
import { resolveSessionTarget, sessionSlug } from "../../application/session-resolver.js";
import { ensureWorkingBranch } from "../../application/working-branch-service.js";
import type { CommandResult } from "../../domain/types.js";
import { type WorklineNodeId, formatNodeId } from "../../domain/workline-node.js";
import { readContextId } from "../context-id.js";
import { type ParsedArgs, flagValue, sessionCodeFlag } from "../parser.js";
import type { CliCommand } from "../registry.js";
import { fail } from "../render.js";
import type { CliContext } from "../types.js";

const USAGE =
  "Usage: aw doc-branch show (--code <NNN>|--doc <spec|plan:NNN|quick:NNN>) | aw doc-branch set (--code <NNN>|--doc <tipo:NNN>) --source <alias> (--rama <nombre>|--from <tipo:NNN>).";

export const docBranchCommand: CliCommand = {
  name: "doc-branch",
  flags: {
    known: [],
    actions: {
      show: { known: ["code", "session", "doc"] },
      set: { known: ["code", "session", "doc", "source", "rama", "from"] },
    },
    usage: USAGE,
  },
  describe: `Show or register a document's own working branch per source, inherited by its plans. Show never fetches or writes; set creates or reuses a branch before recording it. ${USAGE}`,
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const action = args.rest[0];
    if (action !== "show" && action !== "set") return fail("INVALID_INPUT", USAGE);
    const session = sessionCodeFlag(args);
    if (!session.ok) return fail("INVALID_INPUT", session.message);
    const reference = args.values.get("doc");
    if ((reference === undefined) === (session.code === undefined))
      return fail("INVALID_INPUT", USAGE);
    const identity =
      reference !== undefined
        ? await parseDoc(reference, ctx)
        : await fromSession(session.code as string, ctx);
    if (identity.status !== "resolved") {
      return fail(
        "DOC_BRANCH_IDENTITY",
        identity.status === "unreadable" ? identity.reason : "la sesión no nombra un documento",
      );
    }
    const block = await readWorkspaceBlock(
      ctx.fs,
      ctx.paths.workspaceDir(),
      ctx.paths.blockMarkers(),
    );
    if (!block || block.fuentes.length === 0)
      return fail("NO_SOURCES_DECLARED", "el workspace no declara fuentes");
    const read = await readDocBranches(ctx.fs, ctx.paths);
    if (action === "show") {
      const sources = await Promise.all(
        block.fuentes.map(async (source) => {
          const effective = await resolveDocBranch(
            ctx.fs,
            ctx.paths,
            source,
            block,
            identity,
            read,
          );
          const proposed = await proposedName(identity, ctx);
          const local =
            proposed === null ? false : await ctx.git.branchExists(source.path, proposed);
          // The locally fetched refs only: show must never contact origin.
          const remote =
            proposed === null
              ? false
              : (await ctx.git.refValue(source.path, `refs/remotes/origin/${proposed}`)) !== null;
          return { source: source.alias, ...effective, proposed, local, remote };
        }),
      );
      return {
        ok: true,
        exitCode: 0,
        data: {
          doc: formatNodeId(identity.doc),
          sources,
          unreadable: read.unreadable,
          next: `Confirmá con la persona el nombre propuesto (o cambialo) antes de aw doc-branch set --doc ${formatNodeId(identity.doc)} --source <alias> --rama <nombre>`,
        },
      };
    }

    const alias = flagValue(args, "source");
    const source = block.fuentes.find((item) => item.alias === alias);
    if (!source)
      return fail("INVALID_SOURCE", `la fuente ${alias ?? "(ausente)"} no está declarada`);
    const from = flagValue(args, "from");
    const rama = args.values.get("rama");
    if ((from === undefined) === (rama === undefined)) return fail("INVALID_INPUT", USAGE);
    let branch = rama;
    if (from !== undefined) {
      const origin = await parseDoc(from, ctx);
      if (origin.status !== "resolved")
        return fail("DOC_BRANCH_IDENTITY", "el documento de origen no existe");
      branch = ownDocBranch(read, origin.doc, source.alias) ?? undefined;
      if (branch === undefined)
        return fail("DOC_BRANCH_ABSENT", `${from} no tiene rama propia en ${alias}`);
    }
    if (
      !branch ||
      !isPlainBranchName(branch) ||
      branch.startsWith("aw/") ||
      !isWorkingBranch(branch, resolveSourceBranches(source, block))
    ) {
      return fail(
        "INVALID_BRANCH",
        `${branch ?? "(ausente)"} no es una rama de trabajo simple para ${alias}`,
      );
    }
    const result = await ensureWorkingBranch(
      ctx.git,
      source,
      branch,
      resolveSourceBranches(source, block).prod,
    );
    if (!result.ok) return fail("WORKING_BRANCH_UNRESOLVED", result.reason, result);
    await appendDocBranch(ctx.fs, ctx.paths, {
      version: 1,
      at: new Date().toISOString(),
      doc: identity.doc,
      source: source.alias,
      branch,
      by: session.code ?? `aw doc-branch set --doc ${formatNodeId(identity.doc)}`,
      outcome: result.outcome,
    });
    return {
      ok: true,
      exitCode: 0,
      data: {
        doc: formatNodeId(identity.doc),
        source: alias,
        branch,
        outcome: result.outcome,
        ...(result.start_point ? { start_point: result.start_point } : {}),
        unreadable: read.unreadable,
      },
    };
  },
};

async function fromSession(code: string, ctx: CliContext): Promise<DocIdentity> {
  const contextId = readContextId(ctx.env);
  const resolution = await resolveSessionTarget(ctx.fs, ctx.paths, {
    intent: "read",
    code,
    ...(contextId !== undefined ? { contextId } : {}),
    bind: false,
  });
  if (resolution.outcome !== "resolved")
    return { status: "unreadable", reason: resolution.message };
  return documentOfSession(ctx.fs, ctx.paths, resolution.session.folder);
}

async function parseDoc(reference: string, ctx: CliContext): Promise<DocIdentity> {
  const match = /^(spec|plan|quick):(\d{3,})$/.exec(reference);
  if (!match?.[1] || !match[2]) return { status: "none" };
  const doc = { kind: match[1] as WorklineNodeId["kind"], key: match[2] };
  if (doc.kind === "quick") {
    const resolution = await resolveSessionTarget(ctx.fs, ctx.paths, {
      intent: "read",
      code: doc.key,
      bind: false,
    });
    if (resolution.outcome !== "resolved" || !resolution.session.folder.endsWith("-quick"))
      return { status: "none" };
    return {
      status: "resolved",
      doc: { kind: "quick", key: resolution.session.folder },
      path: null,
    };
  }
  const path = await findDocument(ctx.fs, ctx.paths, doc);
  return path === null ? { status: "none" } : { status: "resolved", doc, path };
}

async function proposedName(
  identity: Extract<DocIdentity, { status: "resolved" }>,
  ctx: CliContext,
): Promise<string | null> {
  const { doc } = identity;
  if (doc.kind === "quick") {
    const number = /^(?:session)?(\d{3,})-/.exec(doc.key)?.[1];
    const slug = sessionSlug(doc.key, "quick");
    return number && slug ? `feature/quick-${number}-${slug}` : null;
  }
  const path = identity.path ?? (await findDocument(ctx.fs, ctx.paths, doc));
  if (path === null) return null;
  const slug = basename(path, ".md").replace(new RegExp(`^${doc.key}-${doc.kind}-`), "");
  const proposed = `feature/${doc.kind}-${doc.key}-${slug}`;
  return isPlainBranchName(proposed) ? proposed : null;
}
