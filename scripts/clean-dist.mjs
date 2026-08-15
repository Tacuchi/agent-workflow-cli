import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// TypeScript does not remove output for source files that disappeared. Clean the
// one generated directory first so a local pack cannot ship retired modules.
const scriptsDir = dirname(fileURLToPath(import.meta.url));
rmSync(join(scriptsDir, "..", "dist"), { recursive: true, force: true });
