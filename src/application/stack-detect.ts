// Mirror de qtc_core/project.py:detect_stack_dict.
import { join } from "node:path";
import type { FileSystemPort } from "../ports/file-system.js";
import type { ProjectStack } from "./parsers/project-block.js";

export interface DetectedStack extends ProjectStack {
  wrapper?: string;
}

export async function detectStackDict(
  fs: FileSystemPort,
  projectDir: string,
): Promise<DetectedStack> {
  const has = (rel: string) => fs.exists(join(projectDir, rel));
  if (await has("pom.xml")) return detectMaven(has);
  if ((await has("build.gradle")) || (await has("build.gradle.kts"))) {
    return detectGradle(has);
  }
  if (await has("angular.json")) {
    return { language: "TypeScript", framework: "Angular", build: "npm", wrapper: "ng" };
  }
  if (await has("package.json")) return detectNpm(fs, projectDir);
  return {};
}

async function detectMaven(has: (rel: string) => Promise<boolean>): Promise<DetectedStack> {
  const wrapper = (await has("mvnw")) ? "./mvnw" : (await has("mvnw.cmd")) ? "./mvnw.cmd" : "mvn";
  return { language: "Java", framework: "Spring Boot", build: "Maven", wrapper };
}

async function detectGradle(has: (rel: string) => Promise<boolean>): Promise<DetectedStack> {
  const wrapper = (await has("gradlew"))
    ? "./gradlew"
    : (await has("gradlew.bat"))
      ? "./gradlew.bat"
      : "gradle";
  return { language: "Java", framework: "Spring Boot", build: "Gradle", wrapper };
}

async function detectNpm(fs: FileSystemPort, projectDir: string): Promise<DetectedStack> {
  let framework = "Node";
  let language = "JavaScript";
  try {
    const pkgRaw = await fs.readText(join(projectDir, "package.json"));
    const pkg = JSON.parse(pkgRaw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    framework = pickNpmFramework(deps);
    language = Object.keys(deps).some((k) => k.toLowerCase().includes("typescript"))
      ? "TypeScript"
      : "JavaScript";
  } catch {
    // keep defaults
  }
  return { language, framework, build: "npm", wrapper: "npm" };
}

function pickNpmFramework(deps: Record<string, string>): string {
  if ("react" in deps) return "React";
  if ("vue" in deps) return "Vue";
  return "Node";
}
