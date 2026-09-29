import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { INSTALL_TARGETS, TARGET_ROOTS } from "../../src/application/self/install-targets.js";
import { removeRetiredDesignWrapper } from "../../src/application/self/retired-design-wrapper.js";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const skill = "---\nname: design\n---\nwrapper anterior\n";
const descriptor = '{"name":"design","version":26}\n';
const known = { descriptor: sha256(descriptor), wrappers: new Set([sha256(skill)]) };
const temporary: string[] = [];

afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "aw-retired-wrapper-"));
  temporary.push(root);
  return root;
}

async function ownWrapper(root: string) {
  const path = join(root, "design");
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "SKILL.md"), skill);
  await writeFile(join(path, "workline-capability.json"), descriptor);
  return path;
}

describe("retirada de wrapper propio sin tocar skills ajenas", () => {
  it("retira sólo los dos archivos exactos; repetir la limpieza no cambia nada", async () => {
    const root = await fixture();
    const path = await ownWrapper(root);
    expect(await removeRetiredDesignWrapper(root, known)).toEqual({ path, status: "removed" });
    expect(await removeRetiredDesignWrapper(root, known)).toEqual({ path, status: "absent" });
  });

  it.each(["editado", "descriptor", "adicional", "incompleto"])(
    "preserva %s e informa la causa sin cambiar ningún byte",
    async (variant) => {
      const root = await fixture();
      const path = await ownWrapper(root);
      if (variant === "editado") await writeFile(join(path, "SKILL.md"), `${skill}nota propia\n`);
      if (variant === "descriptor")
        await writeFile(join(path, "workline-capability.json"), `${descriptor} `);
      if (variant === "adicional") await writeFile(join(path, "USER.md"), "contenido ajeno\n");
      if (variant === "incompleto") await rm(join(path, "workline-capability.json"));
      const names = await readdir(path);
      const bytes = await Promise.all(names.map((name) => readFile(join(path, name))));
      const result = await removeRetiredDesignWrapper(root, known);
      expect(result.status).toBe("preserved");
      expect(result.reason).toBeTruthy();
      expect(await readdir(path)).toEqual(names);
      expect(await Promise.all(names.map((name) => readFile(join(path, name))))).toEqual(bytes);
    },
  );

  it("preserva directorios enlazados y archivos enlazados aunque apunten a contenido exacto", async () => {
    const root = await fixture();
    const path = await ownWrapper(root);
    await rm(join(path, "SKILL.md"));
    await writeFile(join(root, "real-skill.md"), skill);
    await symlink(join(root, "real-skill.md"), join(path, "SKILL.md"));
    expect((await removeRetiredDesignWrapper(root, known)).status).toBe("preserved");
    expect((await lstat(join(path, "SKILL.md"))).isSymbolicLink()).toBe(true);
    const alias = join(root, "alias");
    await mkdir(alias);
    await symlink(path, join(alias, "design"));
    expect((await removeRetiredDesignWrapper(alias, known)).status).toBe("preserved");
  });

  it("cubre cada raíz de instalación sin deducir propiedad del nombre ni borrar otra raíz", async () => {
    const home = await fixture();
    const roots = new Set(INSTALL_TARGETS.map((target) => join(home, ...TARGET_ROOTS[target])));
    for (const root of roots) {
      const path = await ownWrapper(root);
      const result = await removeRetiredDesignWrapper(root, known);
      expect(result).toEqual({ path, status: "removed" });
      expect(await removeRetiredDesignWrapper(root, known)).toMatchObject({ status: "absent" });
    }
  });
});
