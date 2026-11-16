import { basename } from "node:path";
import {
  isPlainBranchName,
  isWorkingBranch,
  resolveSourceBranches,
} from "../../application/branch-resolver.js";
import {
  type DocIdentity,
  appendDocBranch,
  findDocument,
  ownDocBranch,
  readDocBranches,
  resolveDocBranch,
} from "../../application/doc-branch-ledger.js";
import { readHubBlock, requireSourcePath } from "../../application/parsers/hub-block.js";
import { ensureWorkingBranch } from "../../application/working-branch-service.js";
import { type AgentWorkflowNodeId, formatNodeId } from "../../domain/agent-workflow-node.js";
import type { CommandResult } from "../../domain/types.js";
import { type ParsedArgs, flagValue } from "../parser.js";
import type { CliCommand } from "../registry.js";
import { fail } from "../render.js";
import type { CliContext } from "../types.js";

const USAGE =
  "Usage: aw doc-branch show --doc <spec|plan:NNN> | aw doc-branch set --doc <spec|plan:NNN> --source <alias> (--rama <nombre>|--from <spec|plan:NNN>).";

export const docBranchCommand: CliCommand = {
  name: "doc-branch",
  flags: {
    known: [],
    actions: {
      show: { known: ["doc"], required: ["doc"] },
      set: {
        known: ["doc", "source", "rama", "from"],
        required: ["doc", "source"],
        exclusive: [["rama", "from"]],
      },
    },
  },
  help: {
    purpose:
      "Show or register a document's own working branch per source, which its plans inherit.",
    actions: {
      show: {
        purpose: "Show the document's branch per source; never fetches or writes.",
        flags: {
          doc: { value: "<spec|plan:NNN>", effect: "The document whose branch it is." },
        },
        output:
          "{doc, sources[] ({source, branch, origin, proposed, local, remote, error_code?, error?}), unreadable[], next}.",
      },
      set: {
        purpose: "Create or reuse a working branch in one source and record it as the document's.",
        flags: {
          doc: { value: "<spec|plan:NNN>", effect: "The document whose branch it is." },
          source: { value: "<alias>", effect: "Source whose branch is recorded." },
          rama: { value: "<branch>", effect: "Branch name to create or reuse." },
          from: {
            value: "<spec|plan:NNN>",
            effect: "Reuse the branch another document already owns in that source.",
          },
        },
        output: "{doc, source, branch, outcome, start_point?, unreadable[]}.",
      },
    },
  },
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const action = args.rest[0];
    if (action !== "show" && action !== "set") return fail("INVALID_INPUT", USAGE);
    const reference = args.values.get("doc");
    if (reference === undefined) return fail("INVALID_INPUT", USAGE);
    const identity = await parseDoc(reference, ctx);
    if (identity.status !== "resolved") {
      return fail(
        "DOC_BRANCH_IDENTITY",
        identity.status === "unreadable"
          ? identity.reason
          : `'${reference}' no nombra un documento`,
      );
    }
    const block = await readHubBlock(ctx.fs, ctx.paths.hubDir(), ctx.paths.blockMarkers());
    if (!block || block.fuentes.length === 0)
      return fail("NO_SOURCES_DECLARED", "el hub no declara fuentes");
    const read = await readDocBranches(ctx.fs, ctx.paths);
    if (action === "show") {
      return showDocumentBranches(ctx, block, identity, read);
    }

    return setDocumentBranch(args, ctx, block, identity, read);
  },
};

async function parseDoc(reference: string, ctx: CliContext): Promise<DocIdentity> {
  // QUICK has no document in 31.0.0: its branch is the one git shows.
  const match = /^(spec|plan):(\d{3,})$/.exec(reference);
  if (!match?.[1] || !match[2]) return { status: "none" };
  const doc = { kind: match[1] as AgentWorkflowNodeId["kind"], key: match[2] };
  const path = await findDocument(ctx.fs, ctx.paths, doc);
  return path === null ? { status: "none" } : { status: "resolved", doc, path };
}

async function proposedName(
  identity: Extract<DocIdentity, { status: "resolved" }>,
  ctx: CliContext,
): Promise<string | null> {
  const { doc } = identity;
  const path = identity.path ?? (await findDocument(ctx.fs, ctx.paths, doc));
  if (path === null) return null;
  const slug = basename(path, ".md").replace(new RegExp(`^${doc.key}-${doc.kind}-`), "");
  const proposed = `feature/${doc.kind}-${doc.key}-${slug}`;
  return isPlainBranchName(proposed) ? proposed : null;
}

async function showDocumentBranches(
  ctx: CliContext,
  block: NonNullable<Awaited<ReturnType<typeof readHubBlock>>>,
  identity: Extract<DocIdentity, { status: "resolved" }>,
  read: Awaited<ReturnType<typeof readDocBranches>>,
): Promise<CommandResult> {
  const sources = await Promise.all(
    block.fuentes.map(async (source) => {
      const effective = await resolveDocBranch(ctx.fs, ctx.paths, source, block, identity, read);
      const proposed = await proposedName(identity, ctx);
      let repo: string;
      try {
        repo = await requireSourcePath(ctx.fs, source);
      } catch (err) {
        return {
          source: source.alias,
          ...effective,
          proposed,
          local: false,
          remote: false,
          error_code: "SOURCE_PATH_MISSING",
          error: (err as Error).message,
        };
      }
      const local = proposed === null ? false : await ctx.git.branchExists(repo, proposed);
      // The locally fetched refs only: show must never contact origin.
      const remote =
        proposed === null
          ? false
          : (await ctx.git.refValue(repo, `refs/remotes/origin/${proposed}`)) !== null;
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

async function setDocumentBranch(
  args: ParsedArgs,
  ctx: CliContext,
  block: NonNullable<Awaited<ReturnType<typeof readHubBlock>>>,
  identity: Extract<DocIdentity, { status: "resolved" }>,
  read: Awaited<ReturnType<typeof readDocBranches>>,
): Promise<CommandResult> {
  const alias = flagValue(args, "source");
  const source = block.fuentes.find((item) => item.alias === alias);
  if (!source) return fail("INVALID_SOURCE", `la fuente ${alias ?? "(ausente)"} no está declarada`);
  let repo: string;
  try {
    repo = await requireSourcePath(ctx.fs, source);
  } catch (err) {
    return fail("SOURCE_PATH_MISSING", (err as Error).message);
  }
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
  if (!isDocumentWorkingBranch(branch, source, block)) {
    return fail(
      "INVALID_BRANCH",
      `${branch ?? "(ausente)"} no es una rama de trabajo simple para ${alias}`,
    );
  }
  const result = await ensureWorkingBranch(
    ctx.git,
    { ...source, path: repo },
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
    by: `aw doc-branch set --doc ${formatNodeId(identity.doc)}`,
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
}

function isDocumentWorkingBranch(
  branch: string | undefined,
  source: Parameters<typeof resolveSourceBranches>[0],
  block: Parameters<typeof resolveSourceBranches>[1],
): branch is string {
  return !(
    !branch ||
    !isPlainBranchName(branch) ||
    branch.startsWith("aw/") ||
    !isWorkingBranch(branch, resolveSourceBranches(source, block))
  );
}
