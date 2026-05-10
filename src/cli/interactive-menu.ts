export interface MenuPredicateInput {
  command: string | undefined;
  isTTY: boolean;
  hasHelp: boolean;
}

export function shouldShowInteractiveMenu(input: MenuPredicateInput): boolean {
  return input.command === undefined && input.isTTY && !input.hasHelp;
}

export type MenuAction = "doctor" | "install-skill" | "mcp" | "update" | "help" | "exit";
