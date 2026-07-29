// Host registry shared by the whole TUI — a PROJECTION of the domain catalog,
// never a second catalog.
//
// It used to be a hand-written list, and it drifted: it carried `Agents` (a
// shared skills dir, not a host) and omitted Oz, so an Oz install was invisible
// across the entire TUI. Everything here is now derived from `HARNESSES` /
// `SHARED_SKILL_DESTINATIONS`; adding or retiring a host in the domain moves the
// TUI with it, and `tests/unit/host-catalog-guards.test.ts` fails if the two
// ever diverge again.
//
// Whether a host has a real install/uninstall backend is still NOT stored here
// — it is derived from the backend's own `TARGET_ROOTS` keys where needed
// (clean-legacy v14.5.1 lesson).

import {
  HARNESSES,
  type InstallTarget,
  SHARED_SKILL_DESTINATIONS,
  type SupportTier,
  verificationFor,
} from "../../domain/harnesses.js";
import type { HarnessVerification } from "../../domain/host-verification.js";

export interface HostMeta {
  /** Stable id used in data + shortcuts. Equals the host's install target. */
  id: InstallTarget;
  /** Long label (shown in cards / detail panels). */
  name: string;
  /** 1-letter glyph for compact chips. */
  glyph: string;
  /** Declared support level — what we promise. */
  tier: SupportTier;
  /** Pre-1.0 host: its surface can change between releases. */
  unstableSurface: boolean;
  /** What a verification run actually proved, or null if none ever ran. */
  verified: HarnessVerification | null;
}

/** A shared skills dir several hosts read. An install destination, not a host. */
export interface SharedDestinationMeta {
  id: InstallTarget;
  name: string;
  glyph: string;
  /** Human-readable dir. */
  dir: string;
  /** Labels of the hosts that read it — why installing here is useful. */
  readBy: readonly string[];
}

export const HOSTS: readonly HostMeta[] = HARNESSES.map((h) => ({
  id: h.installTarget,
  name: h.label,
  glyph: h.glyph,
  tier: h.support.tier,
  unstableSurface: h.support.unstableSurface === true,
  verified: verificationFor(h.id),
}));

export const SHARED_DESTINATIONS: readonly SharedDestinationMeta[] = SHARED_SKILL_DESTINATIONS.map(
  (d) => ({
    id: d.id,
    name: d.label,
    glyph: d.glyph,
    dir: d.dir,
    readBy: d.readBy.map((id) => HARNESSES.find((h) => h.id === id)?.label ?? id),
  }),
);

/**
 * Support pill text for a host: the level plus the version a run verified.
 * A host no run ever covered says exactly that — never a bare "official",
 * which would read as a verification nobody performed (spec 010, criterion 10).
 */
export function supportPill(host: HostMeta): string {
  const level = host.tier === "official" ? "official" : "best-effort";
  if (host.verified === null) return `${level} · unverified`;
  const version = host.verified.version === null ? "no CLI version" : `v${host.verified.version}`;
  return `${level} · ${version} · ${host.verified.at}`;
}
