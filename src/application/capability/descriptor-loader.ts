/**
 * Reading the descriptor an installed skill claims to satisfy.
 *
 * The claim crosses a trust boundary: the frontmatter and the JSON next to it
 * were authored by whoever wrote the skill, and nothing about being installed
 * makes either of them true. So the loader verifies before it believes, in this
 * order, and stops at the first failure:
 *
 * 1. the metadata key exists — its absence is not an error, it means the skill
 *    is ambient and gets no Workline surface;
 * 2. the locator is a confined relative path to a `.json`, sealed with a digest;
 * 3. the resolved file is a real file inside the skill's own directory and NOT a
 *    symlink — a link is how a confined path reaches outside anyway;
 * 4. the bytes produce the sealed digest;
 * 5. the contract version is one this CLI implements, checked before any other
 *    field is read.
 *
 * A failure never loads partially and never touches a binding.
 */

import { join } from "node:path";
import {
  CAPABILITY_DESCRIPTOR_METADATA_KEY,
  parseDescriptorLocator,
  verifyDescriptorPayload,
} from "../../domain/capability/descriptor.js";
import type { CapabilityDescriptor } from "../../domain/capability/descriptor.js";
import type { CapabilityFailure } from "../../domain/capability/protocol.js";
import { getSkillVersion, parseSkillFrontmatter } from "../../domain/skill-frontmatter.js";
import type { FileSystemPort } from "../../ports/file-system.js";

export interface LoadedDescriptor {
  descriptor: CapabilityDescriptor;
  /** Skill-directory-relative path the locator named. */
  path: string;
  digest: string;
}

export type DescriptorLoad =
  /** No claim: an ordinary ambient skill. Not a failure. */
  | { state: "absent" }
  | { state: "loaded"; loaded: LoadedDescriptor }
  | { state: "invalid"; failure: CapabilityFailure };

export interface SkillHead {
  /** `name` from the frontmatter, or the directory name when it declares none. */
  name: string;
  version: string | null;
  /** Raw locator value, still unverified. */
  locatorValue: string | null;
  skillMd: string;
}

/** Read a skill's `SKILL.md` head. Returns null when there is no readable one. */
export async function readSkillHead(
  fs: FileSystemPort,
  skillDir: string,
  dirName: string,
): Promise<SkillHead | null> {
  const skillMd = join(skillDir, "SKILL.md");
  if (!(await fs.exists(skillMd))) return null;
  let text: string;
  try {
    text = await fs.readText(skillMd);
  } catch {
    return null;
  }
  const fm = parseSkillFrontmatter(text);
  if (fm === null) return null;
  return {
    name: fm.fields.name?.trim() || dirName,
    version: getSkillVersion(fm),
    locatorValue: fm.metadata[CAPABILITY_DESCRIPTOR_METADATA_KEY] ?? null,
    skillMd,
  };
}

export async function loadDescriptor(
  fs: FileSystemPort,
  skillDir: string,
  head: SkillHead,
): Promise<DescriptorLoad> {
  if (head.locatorValue === null) return { state: "absent" };

  const parsed = parseDescriptorLocator(head.locatorValue);
  if (!parsed.ok) {
    return {
      state: "invalid",
      failure: { code: parsed.code, message: parsed.message, action: parsed.action },
    };
  }

  const absolute = join(skillDir, parsed.locator.path);
  const link = await fs.lstat(absolute);
  if (link === null) {
    return {
      state: "invalid",
      failure: {
        code: "CAPABILITY_DESCRIPTOR_MISSING",
        message: `'${head.name}' declara un descriptor en '${parsed.locator.path}' y ahí no hay nada`,
        action: "publicá el descriptor junto al SKILL.md, o quitá la clave de metadata",
      },
    };
  }
  // A confined relative path still lands outside if the target is a link. The
  // containment rule is about WHICH BYTES get read, not about how the path looks.
  if (link.isSymlink || link.type !== "file") {
    return {
      state: "invalid",
      failure: {
        code: "CAPABILITY_DESCRIPTOR_NOT_CONFINED",
        message: `'${parsed.locator.path}' no es un archivo dentro del directorio de la skill`,
        action: "publicá el descriptor como archivo real, sin enlaces simbólicos",
      },
    };
  }

  let bytes: string;
  try {
    bytes = await fs.readText(absolute);
  } catch {
    return {
      state: "invalid",
      failure: {
        code: "CAPABILITY_DESCRIPTOR_UNREADABLE",
        message: `no se pudo leer '${parsed.locator.path}'`,
        action: "revisá permisos del archivo del descriptor",
      },
    };
  }

  const verified = verifyDescriptorPayload(parsed.locator, bytes);
  if (!verified.ok) {
    return {
      state: "invalid",
      failure: { code: verified.code, message: verified.message, action: verified.action },
    };
  }
  return {
    state: "loaded",
    loaded: {
      descriptor: verified.descriptor,
      path: parsed.locator.path,
      digest: parsed.locator.digest,
    },
  };
}
