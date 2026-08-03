/**
 * The physical entrypoint: a top-level Agent Skill that IS the capability.
 *
 * Everything a host can load is a directory with a `SKILL.md`, so a capability
 * that is only a paragraph of doctrine is a capability nobody can invoke. This
 * module writes that directory — the instruction file plus the descriptor it
 * points at — derived from the descriptor itself, so the wrapper and the
 * contract cannot describe two different things.
 *
 * Ownership is fail-closed, and that is the whole safety story. A skill root is
 * a SHARED namespace: the person may already have their own `design/` skill
 * there, written by someone else, and it is not ours to overwrite or delete. So
 * install and uninstall both refuse anything that does not carry our marker,
 * preserve its bytes, and hand back an action instead of a surprise.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CAPABILITY_DESCRIPTOR_METADATA_KEY,
  type CapabilityDescriptor,
} from "../../domain/capability/descriptor.js";

/**
 * The ownership fingerprint, same idea as `COMMAND_SKILL_MARKER`: the wrapper
 * proves it is ours by carrying this line, never by matching a name pattern. A
 * skill root is shared, and a prefix is not proof of authorship.
 */
export const CAPABILITY_SKILL_MARKER =
  "Capability skill wrapper (installed by `aw self install-skill`)";

export const CAPABILITY_DESCRIPTOR_FILE = "workline-capability.json";

/** The exact bytes published as the descriptor — the ones the digest seals. */
export function renderDescriptorJson(descriptor: CapabilityDescriptor): string {
  return `${JSON.stringify(descriptor, null, 2)}\n`;
}

export function descriptorLocatorValue(descriptor: CapabilityDescriptor): string {
  const digest = createHash("sha256")
    .update(renderDescriptorJson(descriptor), "utf8")
    .digest("hex");
  return `${CAPABILITY_DESCRIPTOR_FILE}#sha256=${digest}`;
}

/**
 * The instruction file, derived from the descriptor and nothing else.
 *
 * It says one thing: call the shared dispatcher. Restating the operations, the
 * effects or the `off` policy here would be the second contractual description
 * the whole layer exists to prevent — the model reads the descriptor next to it.
 */
export function renderCapabilitySkill(descriptor: CapabilityDescriptor): string {
  const operations = descriptor.operations.map((o) => `\`${o.name}\``).join(", ");
  return [
    "---",
    `name: ${descriptor.name}`,
    "description: >-",
    `  ${descriptor.purpose}. Operaciones: ${descriptor.operations.map((o) => o.name).join(", ")}.`,
    "metadata:",
    `  ${CAPABILITY_DESCRIPTOR_METADATA_KEY}: "${descriptorLocatorValue(descriptor)}"`,
    "---",
    "",
    `> ${CAPABILITY_SKILL_MARKER}. El contrato completo vive en \`./${CAPABILITY_DESCRIPTOR_FILE}\`; este archivo no lo repite.`,
    "",
    `# ${descriptor.name}`,
    "",
    `${descriptor.purpose}.`,
    "",
    "## Cómo se ejecuta",
    "",
    `Toda invocación pasa por el dispatcher compartido, con la operación (${operations}) viajando en el envelope:`,
    "",
    "```",
    `aw capability prepare --capability ${descriptor.name} --operation <op> [--input k=v ...]`,
    "aw capability continue --request <request.json> [--input k=v ...]",
    "aw capability validate --request <request.json>   # stdin: la respuesta autorada",
    "aw capability apply --plan <plan.json> --approval <digest>",
    "```",
    "",
    "Cada intento devuelve `outcome`, `output` y `receipt`. Un `needs_input` se contesta con",
    "`continue`, que construye el intento siguiente del mismo `invocation_id` — nunca reusa el anterior.",
    "",
    "## Lo que esta ruta NO hace",
    "",
    "- No crea, avanza, cierra ni publica una sesión o documento SPEC, PLAN o QUICK.",
    "- No inicializa un workspace: si la operación necesita uno y no lo hay, devuelve un resultado explícito.",
    "- No ejerce ningún efecto que el descriptor no declare, ni uno que exija aprobación sin pedirla.",
    "",
    "La conversación es la del host. Las preguntas de un `needs_input` se hacen acá mismo.",
    "",
  ].join("\n");
}

export type WrapperOwnership =
  | { state: "absent" }
  | { state: "ours" }
  /** Someone else's skill, or ours after a hand edit. Never touched. */
  | { state: "foreign"; why: string };

export async function inspectCapabilityDir(dir: string): Promise<WrapperOwnership> {
  let text: string;
  try {
    text = await readFile(join(dir, "SKILL.md"), "utf8");
  } catch {
    // No SKILL.md. An empty or unrelated dir is not ours to claim either — but
    // it is also not a skill, so installing into it is safe.
    try {
      const entries = await readdir(dir);
      if (entries.length === 0) return { state: "absent" };
      return { state: "foreign", why: `'${dir}' tiene contenido y ningún SKILL.md` };
    } catch {
      return { state: "absent" };
    }
  }
  if (text.includes(CAPABILITY_SKILL_MARKER)) return { state: "ours" };
  return {
    state: "foreign",
    why: `'${dir}' ya tiene un SKILL.md que no instalamos nosotros`,
  };
}

export interface WrapperFailure {
  code: string;
  message: string;
  action: string;
}

export type WrapperInstall =
  | { ok: true; dir: string; files: string[] }
  | { ok: false; failure: WrapperFailure };

/**
 * Write (or rewrite) the wrapper. Idempotent: reinstalling over our own copy
 * produces the same bytes, so a second run is a no-op in content terms.
 */
export async function installCapabilitySkill(
  root: string,
  descriptor: CapabilityDescriptor,
): Promise<WrapperInstall> {
  const dir = join(root, descriptor.name);
  const ownership = await inspectCapabilityDir(dir);
  if (ownership.state === "foreign") {
    return {
      ok: false,
      failure: {
        code: "CAPABILITY_WRAPPER_CONFLICT",
        message: ownership.why,
        action: `renombrá o quitá esa skill para que '${descriptor.name}' pueda instalarse; no se sobrescribe contenido ajeno`,
      },
    };
  }

  await mkdir(dir, { recursive: true });
  const skillMd = join(dir, "SKILL.md");
  const descriptorPath = join(dir, CAPABILITY_DESCRIPTOR_FILE);
  // Descriptor first: between the two writes the SKILL.md must never point at a
  // file that is not there yet, or a host reading mid-install sees a broken
  // locator instead of no skill at all.
  await writeFile(descriptorPath, renderDescriptorJson(descriptor), "utf8");
  await writeFile(skillMd, renderCapabilitySkill(descriptor), "utf8");
  return { ok: true, dir, files: [skillMd, descriptorPath] };
}

export type WrapperUninstall =
  | { ok: true; removed: boolean; dir: string }
  | { ok: false; failure: WrapperFailure };

/** Remove only what we installed. Anything else is preserved, byte for byte. */
export async function uninstallCapabilitySkill(
  root: string,
  name: string,
): Promise<WrapperUninstall> {
  const dir = join(root, name);
  const ownership = await inspectCapabilityDir(dir);
  if (ownership.state === "absent") return { ok: true, removed: false, dir };
  if (ownership.state === "foreign") {
    return {
      ok: false,
      failure: {
        code: "CAPABILITY_WRAPPER_FOREIGN",
        message: ownership.why,
        action: "no se borra una skill que no instalamos: quitala vos si querés",
      },
    };
  }
  await rm(dir, { recursive: true, force: true });
  return { ok: true, removed: true, dir };
}
