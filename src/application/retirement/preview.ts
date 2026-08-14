/**
 * The preview: the sealed proposal, read out loud.
 *
 * Every line below is DERIVED from the record — nothing is authored here and
 * nothing is looked up again. That is the property the whole authorization rests
 * on: the person reads this, approves the digest, and `apply` performs the same
 * object. A preview assembled from a second reading of the workspace could describe
 * a retirement that differs from the one being approved, and it would be the
 * description a human trusts.
 *
 * The human projection and the JSON are two renderings of one structure for the
 * same reason: a terminal user and an agent host must be able to disagree about
 * formatting and never about scope.
 */

import type { RetirementProposal } from "../../domain/retirement/proposal.js";
import { proposesReverts } from "../../domain/retirement/proposal.js";
import { formatNodeId } from "../../domain/workline-node.js";

export interface RetirementPreview {
  mode: RetirementProposal["mode"];
  target: string;
  digest: string;
  /** What disappears, in removal order. */
  disappears: Array<{ node: string; path: string; reason: string }>;
  /** Paths whose bytes come back, and the ones that go back to not existing. */
  restores: Array<{ path: string; to: "bytes-previos" | "inexistente"; changed_since: boolean }>;
  /** Paths whose current content is dropped, per working tree. */
  local_changes: Array<{ alias: string; tree: string; paths: string[]; exclusive_unit: boolean }>;
  /** Commits that get a revert commit — never a rewrite. */
  reverts: Array<{ alias: string; commit: string; ref: string; published: boolean }>;
  /** Isolation units the retirement reconciles. */
  units: Array<{ alias: string; session: string; branch: string }>;
  /** Conversation associations that stop resolving. */
  bindings: number;
  /** The single row HISTORY gains on success. */
  history_row: string;
  /** Whether authorizing this means authorizing commits. */
  touches_git_history: boolean;
}

export function retirementPreview(proposal: RetirementProposal): RetirementPreview {
  return {
    mode: proposal.mode,
    target: formatNodeId(proposal.target),
    digest: proposal.digest,
    disappears: proposal.closure.map((entry) => ({
      node: formatNodeId(entry.node),
      path: entry.path,
      reason: entry.reason,
    })),
    restores: proposal.restores.map((restore) => ({
      path: restore.path,
      to: restore.existed ? ("bytes-previos" as const) : ("inexistente" as const),
      // What the person most needs to see: the file moved since the baseline was
      // sealed, so restoring it discards whatever happened in between.
      changed_since: restore.current_digest !== restore.digest,
    })),
    local_changes: proposal.dirty.map((change) => ({
      alias: change.alias,
      tree: change.tree,
      paths: change.paths,
      exclusive_unit: change.exclusive_unit,
    })),
    reverts: proposal.reverts.map((revert) => ({
      alias: revert.alias,
      commit: revert.commit,
      ref: revert.ref,
      published: revert.published,
    })),
    units: proposal.units.map((unit) => ({
      alias: unit.alias,
      session: unit.session,
      branch: unit.branch,
    })),
    bindings: proposal.bindings.length,
    history_row: `${proposal.event.command} · ${proposal.event.key} · ${proposal.event.summary}`,
    touches_git_history: proposesReverts(proposal),
  };
}

/**
 * The terminal reading of the same structure.
 *
 * A section with nothing in it is omitted rather than printed empty: a preview
 * that lists "reverts: none" next to five other empty headings buries the two
 * lines that matter, and what matters here is noticing a revert BEFORE approving.
 */
export function renderRetirementPreview(preview: RetirementPreview): string {
  const lines: string[] = [];
  const verb = preview.mode === "discard" ? "Retirar" : "Restaurar";
  lines.push(`${verb} ${preview.target}`);
  lines.push(`Digest de aprobación: ${preview.digest}`);

  section(
    lines,
    "Desaparece",
    preview.disappears.map((d) => `${d.node} — ${d.path} (${d.reason})`),
  );
  section(
    lines,
    "Vuelve atrás",
    preview.restores.map(
      (r) => `${r.path} → ${r.to}${r.changed_since ? " (cambió desde el baseline)" : ""}`,
    ),
  );
  section(
    lines,
    "Cambios locales que se descartan",
    preview.local_changes.map(
      (c) =>
        `${c.alias} (${c.exclusive_unit ? "unidad exclusiva" : "checkout compartido"}): ${c.paths.join(", ")}`,
    ),
  );
  section(
    lines,
    "Commits que se revierten (nuevo commit, sin reescribir)",
    preview.reverts.map(
      (r) =>
        `${r.alias} ${r.commit.slice(0, 12)} → ${r.ref}${r.published ? " · publicado: el push queda pendiente y externo" : ""}`,
    ),
  );
  section(
    lines,
    "Unidades que se reconcilian",
    preview.units.map((u) => `${u.alias} · ${u.branch}`),
  );
  if (preview.bindings > 0) {
    section(lines, "Asociaciones de conversación que dejan de resolver", [`${preview.bindings}`]);
  }
  section(lines, "Huella en HISTORY", [preview.history_row]);
  return lines.join("\n");
}

function section(lines: string[], title: string, items: readonly string[]): void {
  if (items.length === 0) return;
  lines.push("", `${title}:`);
  for (const item of items) lines.push(`  - ${item}`);
}
