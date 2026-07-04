// After installing an MCP in Warp by writing .warp/.mcp.json, the file exists
// but Warp only spawns it when the "File-based MCP Servers" toggle is enabled
// in Settings. This service builds the educational hint delivered to the user
// from the CLI and the TUI to close that UX gap.

export type WarpHintScope = "workspace" | "global";

export interface WarpPostInstallHint {
  scope: WarpHintScope;
  file: string;
  name: string;
  lines: string[];
  doc_url: string;
}

const DOC_URL = "https://docs.warp.dev/agent-platform/warp-agents/mcp";

export function buildWarpPostInstallHint(
  name: string,
  scope: WarpHintScope,
  file: string,
): WarpPostInstallHint {
  const scopeLabel = scope === "global" ? "global" : "project";
  const reloadHint =
    scope === "workspace"
      ? `Si Warp ya estaba abierto, reabrí la ventana o el tab cuyo cwd sea el repo (${file}).`
      : "Si Warp ya estaba abierto, reiniciá la aplicación para que detecte el archivo.";

  const lines = [
    `MCP '${name}' escrito en ${file} (scope ${scopeLabel}).`,
    "Abrí Warp → Settings → Agents → MCP servers.",
    "Verificá que 'File-based MCP Servers' esté activado (toggle ON).",
    `Confirmá que '${file}' aparece bajo los providers detectados como 'Warp'.`,
    reloadHint,
  ];

  return { scope, file, name, lines, doc_url: DOC_URL };
}

export function formatWarpPostInstallHint(hint: WarpPostInstallHint): string {
  const numbered = hint.lines
    .slice(1)
    .map((line, idx) => `  ${idx + 1}. ${line}`)
    .join("\n");
  return [hint.lines[0], "Para que Warp lo spawnee:", numbered, `Doc: ${hint.doc_url}`].join("\n");
}
