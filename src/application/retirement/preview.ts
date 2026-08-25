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
  /**
   * What each session in the closure declared it was holding.
   *
   * Shown even when it is uneventful because its INTERESTING value is a zero, and
   * a section that only appears on zero would be a section nobody learns to read.
   */
  custody: Array<{ session: string; declared: number; restored: number }>;
  /**
   * `true` when this retirement puts no file back at all.
   *
   * Derived rather than authored, and stated as its own flag because the preview
   * omits empty sections: without it, "nothing is restored" would be communicated
   * by the absence of a heading, which is the silence `S029/AC-06` refuses.
   */
  restores_nothing: boolean;
  /** Paths whose current content is dropped, per working tree. */
  local_changes: Array<{ alias: string; tree: string; paths: string[]; exclusive_unit: boolean }>;
  /** Commits that get a revert commit — never a rewrite. */
  reverts: Array<{ alias: string; commit: string; ref: string; published: boolean }>;
  /**
   * The single ref the retirement moves, and the value it must still have.
   *
   * Shown because it is the operation's hinge: it is what turns "the commits get
   * reverted" into a statement somebody can check afterwards, and what says which
   * branch is about to gain a commit.
   */
  publication: {
    alias: string;
    ref: string;
    expected_old: string | null;
    expected_tree: string;
    revert_count: number;
  } | null;
  /** Isolation units the retirement reconciles. */
  units: Array<{ alias: string; session: string; branch: string }>;
  /**
   * Held correlatives the retired sessions give back, and the ones they do not.
   *
   * Both halves in one list, because the person approving needs to see the same
   * decision twice over: a number that comes back, and a number that stays held
   * because somebody wrote into it. Splitting them into two sections would let
   * the second one be an ABSENT heading, which is how a stranded correlative
   * became invisible in the first place.
   */
  reservations: Array<{ path: string; owner: string; released: boolean }>;
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
    custody: proposal.custody.map((scope) => ({
      session: scope.session,
      declared: scope.declared,
      restored: scope.restored,
    })),
    restores_nothing: proposal.restores.length === 0,
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
    publication:
      proposal.publication === null
        ? null
        : {
            alias: proposal.publication.alias,
            ref: proposal.publication.ref,
            expected_old: proposal.publication.expected_old,
            expected_tree: proposal.publication.expected_tree,
            revert_count: proposal.publication.revert_count,
          },
    units: proposal.units.map((unit) => ({
      alias: unit.alias,
      session: unit.session,
      branch: unit.branch,
    })),
    reservations: proposal.reservations.map((reservation) => ({
      path: reservation.path,
      owner: reservation.claim.owner,
      // The DECISION, not the input fact: what a reader has to weigh is whether
      // the number comes back, and `intact` is only the reason it does.
      released: reservation.intact,
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
  // Said BEFORE the sections rather than by omitting one of them: a `reset` whose
  // scope declared no input restores nothing, and the person about to approve it
  // believes they are going back to a previous state. A discard never restores, so
  // announcing it there would be noise instead of a warning.
  if (preview.mode === "reset" && preview.restores_nothing) {
    lines.push(
      "",
      "Nada vuelve atrás: ninguna sesión del alcance declaró entradas, así que este reset no devuelve ningún archivo a su estado previo.",
    );
  }

  section(
    lines,
    "Custodia declarada",
    preview.custody.map((scope) => custodyLine(preview.mode, scope)),
  );
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
  if (preview.publication !== null) {
    const p = preview.publication;
    section(lines, "Punto de commit (el único)", [
      `${p.alias} · ${p.ref} · desde ${(p.expected_old ?? "inexistente").slice(0, 12)} · ${p.revert_count} revert(s) hasta el árbol ${p.expected_tree.slice(0, 12)}`,
    ]);
  }
  section(
    lines,
    "Unidades que se reconcilian",
    preview.units.map((u) => `${u.alias} · ${u.branch}`),
  );
  section(
    lines,
    "Reservas de numeración que se liberan",
    preview.reservations.filter((r) => r.released).map((r) => `${r.path} (de ${r.owner})`),
  );
  section(
    lines,
    "Reservas que NO se liberan: sus bytes ya no son el marcador de su dueño",
    preview.reservations
      .filter((r) => !r.released)
      .map(
        (r) =>
          // Phrased as what will be true AFTERWARDS, never as a command to run
          // now: while this preview is on screen the retirement has not happened,
          // its owner may still be alive, and `aw claims recover` on a live
          // session's slot revokes it irrevocably.
          `${r.path} — alguien escribió ahí; el correlativo queda tomado y, una vez aplicado este retiro, lo libera 'aw claims recover ${r.path} --confirm-no-producer'`,
      ),
  );
  if (preview.bindings > 0) {
    section(lines, "Asociaciones de conversación que dejan de resolver", [`${preview.bindings}`]);
  }
  section(lines, "Huella en HISTORY", [preview.history_row]);
  return lines.join("\n");
}

/**
 * One session's declaration, read for the mode that is about to run.
 *
 * A discard never restores, so quoting a restore count there would describe a
 * decision nobody is taking; what a discard's reader needs is only how much the
 * session had declared it was holding.
 */
function custodyLine(
  mode: RetirementPreview["mode"],
  scope: RetirementPreview["custody"][number],
): string {
  if (scope.declared === 0) {
    return `${scope.session}: sin artefactos declarados — su custodia nació vacía y no hay estado previo que devolver`;
  }
  const declared = `${scope.session}: ${scope.declared} artefacto(s) declarados`;
  if (mode === "discard") return declared;
  return scope.restored === 0
    ? `${declared}, ninguno es una entrada: no vuelve atrás ninguno`
    : `${declared}, ${scope.restored} vuelve(n) atrás`;
}

function section(lines: string[], title: string, items: readonly string[]): void {
  if (items.length === 0) return;
  lines.push("", `${title}:`);
  for (const item of items) lines.push(`  - ${item}`);
}
