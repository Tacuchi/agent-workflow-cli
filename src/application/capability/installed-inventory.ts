/**
 * What is ACTUALLY installed, as exact instances.
 *
 * The advisory check this replaces compared names. A name is not a thing that
 * runs: two directories can both be called `design`, and picking one by scan
 * order is a silent choice nobody made. So the unit here is an instance —
 * name, scope, the locator of its `SKILL.md`, the locator of its descriptor, its
 * version and a digest over its bytes — and the two failure modes are kept
 * apart:
 *
 * - **Same name, same digest, several roots.** Equivalent replicas. Every
 *   locator is kept, because "which copy answered" is still a real question.
 * - **Same name, different bytes.** `misconfigured`. Not a precedence puzzle to
 *   resolve — two different things are wearing one name, and no scan order makes
 *   that safe.
 *
 * Only skills that DECLARE a descriptor enter this inventory. An ambient skill —
 * a linter, a writing convention — is installed and invisible here, which is the
 * whole content of the opt-in.
 */

import { createHash } from "node:crypto";
import type { CapabilityDescriptor } from "../../domain/capability/descriptor.js";
import type { CapabilityFailure } from "../../domain/capability/protocol.js";
import { RETIRED_SKILL_IDENTITIES } from "../../domain/skills.js";
import type { EnvPort } from "../../ports/env.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import { semanticDigest } from "../semantic-operation/protocol.js";
import { skillRoots } from "../skills-resolver-service.js";
import { loadDescriptor, readSkillHead } from "./descriptor-loader.js";
import type { SkillHead } from "./descriptor-loader.js";

export interface InstanceLocation {
  /** The skill root this copy was found under. */
  scope: string;
  skillDir: string;
  skillMd: string;
  /** Skill-relative descriptor path, or null when the claim did not survive. */
  descriptorPath: string | null;
}

export interface InstalledCapability {
  name: string;
  version: string | null;
  /** Digest over the instance's bytes. Null when copies disagree. */
  digest: string | null;
  locations: InstanceLocation[];
  /** Null when the instance is `misconfigured`. */
  descriptor: CapabilityDescriptor | null;
  state: "ready" | "misconfigured";
  failure: CapabilityFailure | null;
}

export interface CapabilityInventory {
  roots: string[];
  capabilities: InstalledCapability[];
}

interface Candidate {
  name: string;
  version: string | null;
  digest: string | null;
  location: InstanceLocation;
  descriptor: CapabilityDescriptor | null;
  failure: CapabilityFailure | null;
}

export async function buildCapabilityInventory(
  fs: FileSystemPort,
  env: EnvPort,
  workspaceRoot?: string,
): Promise<CapabilityInventory> {
  const roots = skillRoots(env, workspaceRoot);
  const candidates: Candidate[] = [];
  for (const root of roots) {
    candidates.push(...(await scanRoot(fs, root)));
  }
  return { roots, capabilities: group(candidates) };
}

async function scanRoot(fs: FileSystemPort, root: string): Promise<Candidate[]> {
  if (!(await fs.exists(root))) return [];
  let entries: Awaited<ReturnType<FileSystemPort["list"]>>;
  try {
    entries = await fs.list(root);
  } catch {
    return [];
  }

  const found: Candidate[] = [];
  for (const entry of entries) {
    if (entry.type !== "dir") continue;
    const head = await readSkillHead(fs, entry.path, entry.name);
    // No readable head, or no claim at all: an ambient skill. It never becomes a
    // capability by being installed, so it never enters the inventory.
    if (head === null || head.locatorValue === null) continue;
    found.push(await candidateFor(fs, root, entry.path, head));
  }
  return found;
}

async function candidateFor(
  fs: FileSystemPort,
  root: string,
  skillDir: string,
  head: SkillHead,
): Promise<Candidate> {
  const location: InstanceLocation = {
    scope: root,
    skillDir,
    skillMd: head.skillMd,
    descriptorPath: null,
  };
  const base = { name: head.name, version: head.version, location, descriptor: null } as const;

  // A directory wearing a retired name is refused before its descriptor is even
  // read: the name IS the identity, and honoring it would resurrect the alias
  // the contract exists to close.
  const retired = RETIRED_SKILL_IDENTITIES.get(head.name.toLowerCase());
  if (retired !== undefined) {
    return {
      ...base,
      digest: null,
      failure: {
        code: "CAPABILITY_NAME_RETIRED",
        message: `'${head.name}' está retirado — ${retired}`,
        action: "renombrá la skill al nombre vigente de la capacidad; no hay alias",
      },
    };
  }

  const load = await loadDescriptor(fs, skillDir, head);
  if (load.state !== "loaded") {
    return {
      ...base,
      digest: null,
      failure: load.state === "invalid" ? load.failure : null,
    };
  }
  return {
    name: head.name,
    version: head.version,
    digest: await instanceDigest(fs, head.skillMd, load.loaded.digest),
    location: { ...location, descriptorPath: load.loaded.path },
    descriptor: load.loaded.descriptor,
    failure: null,
  };
}

/**
 * The identity of the bytes that would run: the instruction file AND the
 * contract it points at. Sealing only the descriptor would call two skills
 * identical while their `SKILL.md` told the host to do different things.
 */
async function instanceDigest(
  fs: FileSystemPort,
  skillMd: string,
  descriptorDigest: string,
): Promise<string | null> {
  try {
    const text = await fs.readText(skillMd);
    return semanticDigest({
      skill_md: createHash("sha256").update(text, "utf8").digest("hex"),
      descriptor: descriptorDigest,
    });
  } catch {
    return null;
  }
}

function group(candidates: Candidate[]): InstalledCapability[] {
  const byName = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    byName.set(candidate.name, [...(byName.get(candidate.name) ?? []), candidate]);
  }

  const out: InstalledCapability[] = [];
  for (const [name, copies] of byName) {
    const locations = copies.map((c) => c.location);
    const broken = copies.find((c) => c.failure !== null);
    if (broken?.failure != null) {
      out.push({
        name,
        version: broken.version,
        digest: null,
        locations,
        descriptor: null,
        state: "misconfigured",
        failure: broken.failure,
      });
      continue;
    }

    const digests = [...new Set(copies.map((c) => c.digest))];
    const first = copies[0] as Candidate;
    if (digests.length > 1) {
      out.push({
        name,
        version: first.version,
        digest: null,
        locations,
        descriptor: null,
        state: "misconfigured",
        failure: {
          code: "CAPABILITY_INSTANCE_COLLISION",
          message: `hay ${copies.length} skills llamadas '${name}' con bytes distintos: ${locations.map((l) => l.skillDir).join(", ")}`,
          action:
            "dejá una sola instalación de ese nombre, o renombrá la que no corresponde: no hay precedencia entre roots",
        },
      });
      continue;
    }
    out.push({
      name,
      version: first.version,
      digest: first.digest,
      locations,
      descriptor: first.descriptor,
      state: "ready",
      failure: null,
    });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function findInstalled(
  inventory: CapabilityInventory,
  name: string,
): InstalledCapability | null {
  return inventory.capabilities.find((c) => c.name === name) ?? null;
}
