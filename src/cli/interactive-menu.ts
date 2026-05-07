import { select } from "@inquirer/prompts";

export interface MenuPredicateInput {
  command: string | undefined;
  isTTY: boolean;
  hasHelp: boolean;
}

export function shouldShowInteractiveMenu(input: MenuPredicateInput): boolean {
  return input.command === undefined && input.isTTY && !input.hasHelp;
}

export type MenuAction = "doctor" | "install-skill" | "update" | "help" | "exit";

export async function runInteractiveMenu(version: string): Promise<MenuAction> {
  return select<MenuAction>({
    message: `agent-workflow v${version}`,
    choices: [
      { name: "Doctor (verificar instalación)", value: "doctor" },
      { name: "Install/Update skill (manager bundled)", value: "install-skill" },
      { name: "Update CLI (npm i -g @tacuchi/agent-workflow)", value: "update" },
      { name: "Help (lista de comandos)", value: "help" },
      { name: "Exit", value: "exit" },
    ],
  });
}
