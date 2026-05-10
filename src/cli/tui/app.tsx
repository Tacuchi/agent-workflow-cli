import { useApp } from "ink";
import { useState } from "react";
import type { SelfMcpConfigData } from "../../application/self/mcp-config.js";
import type { CommandResult, ExitCode } from "../../domain/types.js";
import type { MenuAction } from "../interactive-menu.js";
import type { CliContext } from "../types.js";
import { MainMenu } from "./screens/main-menu.js";
import { McpDoneScreen } from "./screens/mcp-done.js";
import { McpWizardScreen } from "./screens/mcp-wizard.js";

export type TuiResult =
  | { kind: "menu-action"; action: MenuAction }
  | { kind: "exit"; exitCode: ExitCode };

type Screen = "menu" | "mcp" | "mcp-done";

export interface AppProps {
  version: string;
  ctx: CliContext;
  onResult: (result: TuiResult) => void;
}

export function App({ version, ctx, onResult }: AppProps) {
  const [screen, setScreen] = useState<Screen>("menu");
  const [mcpResult, setMcpResult] = useState<CommandResult<SelfMcpConfigData> | null>(null);
  const { exit } = useApp();

  if (screen === "menu") {
    return (
      <MainMenu
        version={version}
        onSelect={(action) => {
          if (action === "mcp") {
            setScreen("mcp");
            return;
          }
          if (action === "exit") {
            onResult({ kind: "exit", exitCode: 0 });
            exit();
            return;
          }
          onResult({ kind: "menu-action", action });
          exit();
        }}
      />
    );
  }

  if (screen === "mcp") {
    return (
      <McpWizardScreen
        version={version}
        ctx={ctx}
        onDone={(result) => {
          setMcpResult(result);
          setScreen("mcp-done");
        }}
      />
    );
  }

  if (screen === "mcp-done" && mcpResult) {
    return (
      <McpDoneScreen
        version={version}
        result={mcpResult}
        onContinue={() => {
          setMcpResult(null);
          setScreen("menu");
        }}
        onExit={() => {
          onResult({ kind: "exit", exitCode: mcpResult.exitCode });
          exit();
        }}
      />
    );
  }

  return null;
}
