import { render } from "ink";
import type { CliContext } from "../types.js";
import { App, type TuiResult } from "./app.js";

export async function runTui(version: string, ctx: CliContext): Promise<TuiResult> {
  return new Promise<TuiResult>((resolve) => {
    let resolved = false;
    const settle = (result: TuiResult) => {
      if (resolved) return;
      resolved = true;
      resolve(result);
    };

    const instance = render(<App version={version} ctx={ctx} onResult={settle} />, {
      exitOnCtrlC: true,
    });

    instance
      .waitUntilExit()
      .then(() => settle({ kind: "exit", exitCode: 0 }))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`tui error: ${message}\n`);
        settle({ kind: "exit", exitCode: 1 });
      });
  });
}
