// Mirror de qtc_core/project.py:detect_stack_dict.
import { join } from "node:path";
import type { FileSystemPort } from "../ports/file-system.js";
import type { ProjectStack } from "./parsers/project-block.js";

export async function detectStackDict(
  fs: FileSystemPort,
  projectDir: string,
): Promise<ProjectStack> {
  const has = async (rel: string) => fs.exists(join(projectDir, rel));

  if (await has("pom.xml")) {
    return {
      language: "Java",
      framework: "Spring Boot",
      build: "Maven",
    };
  }
  if ((await has("build.gradle")) || (await has("build.gradle.kts"))) {
    return {
      language: "Java",
      framework: "Spring Boot",
      build: "Gradle",
    };
  }
  if (await has("angular.json")) {
    return {
      language: "TypeScript",
      framework: "Angular",
      build: "npm",
    };
  }
  if (await has("package.json")) {
    let framework = "Node";
    let language = "JavaScript";
    try {
      const pkgRaw = await fs.readText(join(projectDir, "package.json"));
      const pkg = JSON.parse(pkgRaw) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if ("react" in deps) framework = "React";
      else if ("vue" in deps) framework = "Vue";
      else framework = "Node";
      language = Object.keys(deps).some((k) => k.toLowerCase().includes("typescript"))
        ? "TypeScript"
        : "JavaScript";
    } catch {
      // keep defaults
    }
    return { language, framework, build: "npm" };
  }
  return {};
}
