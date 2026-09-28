import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { PathsService } from "../../src/application/paths-service.js";
import { TuiPrefsService } from "../../src/cli/tui/tui-prefs.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";

it("initialScreen=skills histórico abre Status en memoria y conserva el archivo byte a byte", async () => {
  const home = await mkdtemp(join(tmpdir(), "tui-prefs-historic-"));
  try {
    const paths = new PathsService(normalizeNamespace("workflow"), home, home);
    const file = join(paths.userLibConfigDir(), "tui-prefs.json");
    const historic = '{"initialScreen":"skills","accentColor":"violet","disabledHosts":[]}\n';
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, historic);
    const prefs = await new TuiPrefsService(new NodeFileSystem(), paths).load();
    expect(prefs.initialScreen).toBe("status");
    expect(await readFile(file, "utf8")).toBe(historic);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
