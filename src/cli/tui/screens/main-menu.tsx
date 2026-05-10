import type { MenuAction } from "../../interactive-menu.js";
import { Header } from "../components/header.js";
import { KeymapBar } from "../components/keymap-bar.js";
import { ScreenFrame } from "../components/screen-frame.js";
import { type MenuItem, SectionedMenu } from "../components/sectioned-menu.js";

const MENU_ITEMS: MenuItem<MenuAction>[] = [
  { kind: "section", label: "Verificar / configurar" },
  { kind: "item", label: "Doctor (verificar instalación)", value: "doctor" },
  { kind: "item", label: "Install / Update skill (manager bundled)", value: "install-skill" },
  { kind: "item", label: "Configurar MCP database (dbhub)", value: "mcp" },
  { kind: "section", label: "Mantenimiento" },
  { kind: "item", label: "Update CLI (npm i -g @tacuchi/agent-workflow-cli)", value: "update" },
  { kind: "item", label: "Help (lista de comandos)", value: "help" },
  { kind: "section" },
  { kind: "item", label: "Salir", value: "exit" },
];

export interface MainMenuProps {
  version: string;
  onSelect: (action: MenuAction) => void;
  isActive?: boolean;
}

export function MainMenu({ version, onSelect, isActive = true }: MainMenuProps) {
  return (
    <ScreenFrame>
      <Header version={version} subtitle="Menú principal" />
      <SectionedMenu items={MENU_ITEMS} onSelect={onSelect} isActive={isActive} />
      <KeymapBar
        entries={[
          { key: "↑↓", action: "navegar" },
          { key: "⏎", action: "seleccionar" },
          { key: "^C", action: "salir" },
        ]}
      />
    </ScreenFrame>
  );
}
