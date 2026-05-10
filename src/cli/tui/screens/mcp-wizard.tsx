import { Spinner } from "@inkjs/ui";
import { Box, Text, useApp } from "ink";
import { useEffect, useRef, useState } from "react";
import {
  type SelfMcpConfigData,
  type SelfMcpPrompts,
  selfMcpConfig,
} from "../../../application/self/mcp-config.js";
import type { CommandResult } from "../../../domain/types.js";
import type { ParsedArgs } from "../../parser.js";
import type { CliContext } from "../../types.js";
import { Footer } from "../components/footer.js";
import { Header } from "../components/header.js";
import { InputPrompt } from "../components/input-prompt.js";
import { type MenuItem, SectionedMenu } from "../components/sectioned-menu.js";

interface SelectPromptState {
  kind: "select";
  message: string;
  items: MenuItem<string>[];
  defaultValue?: string;
  resolve: (value: string) => void;
}

interface InputPromptState {
  kind: "input";
  message: string;
  defaultValue?: string;
  validate?: (value: string) => boolean | string;
  resolve: (value: string) => void;
}

type ActivePrompt = SelectPromptState | InputPromptState | null;

export interface McpWizardScreenProps {
  version: string;
  ctx: CliContext;
  onDone: (result: CommandResult<SelfMcpConfigData>) => void;
}

function buildEmptyArgs(): ParsedArgs {
  return {
    rest: [],
    plugin: {},
    flags: new Set(),
    values: new Map(),
    valuesMulti: new Map(),
  };
}

function toMenuItem(
  choice: Parameters<SelfMcpPrompts["select"]>[0]["choices"][number],
): MenuItem<string> {
  if ((choice as { type?: string }).type === "separator") {
    const sep = choice as { separator?: string };
    return sep.separator !== undefined
      ? { kind: "section", label: sep.separator.replace(/^── | ──$/g, "") }
      : { kind: "section" };
  }
  const item = choice as { name: string; value: string; description?: string };
  const base: MenuItem<string> = { kind: "item", label: item.name, value: item.value };
  return item.description !== undefined ? { ...base, description: item.description } : base;
}

export function McpWizardScreen({ version, ctx, onDone }: McpWizardScreenProps) {
  const [activePrompt, setActivePrompt] = useState<ActivePrompt>(null);
  const [errorMessage, setErrorMessage] = useState<string | undefined>();
  const startedRef = useRef(false);
  const { exit } = useApp();

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const prompts: SelfMcpPrompts = {
      select<T extends string>(options: {
        message: string;
        choices: Parameters<SelfMcpPrompts["select"]>[0]["choices"];
        default?: T;
      }) {
        return new Promise<T>((resolve) => {
          const items = options.choices.map(toMenuItem);
          const state: SelectPromptState = {
            kind: "select",
            message: options.message,
            items,
            resolve: (value: string) => {
              setActivePrompt(null);
              resolve(value as T);
            },
            ...(options.default !== undefined ? { defaultValue: options.default } : {}),
          };
          setActivePrompt(state);
        });
      },
      input(options) {
        return new Promise<string>((resolve) => {
          const state: InputPromptState = {
            kind: "input",
            message: options.message,
            resolve: (value: string) => {
              setActivePrompt(null);
              resolve(value);
            },
            ...(options.default !== undefined ? { defaultValue: options.default } : {}),
            ...(options.validate ? { validate: options.validate } : {}),
          };
          setActivePrompt(state);
        });
      },
    };

    selfMcpConfig(buildEmptyArgs(), ctx, prompts)
      .then((result) => {
        onDone(result);
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        setErrorMessage(message);
        exit();
      });
  }, [ctx, onDone, exit]);

  if (errorMessage) {
    return (
      <Box flexDirection="column">
        <Header version={version} subtitle="Configurar MCP database (dbhub)" />
        <Text color="red">Error: {errorMessage}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Header version={version} subtitle="Configurar MCP database (dbhub)" />
      {activePrompt === null ? (
        <Box>
          <Spinner label="Procesando..." />
        </Box>
      ) : activePrompt.kind === "select" ? (
        <Box flexDirection="column">
          <Text>
            <Text color="cyan">? </Text>
            {activePrompt.message}
          </Text>
          <Box marginTop={1}>
            <SectionedMenu
              items={activePrompt.items}
              onSelect={(value) => activePrompt.resolve(value)}
              {...(activePrompt.defaultValue !== undefined
                ? { defaultValue: activePrompt.defaultValue }
                : {})}
            />
          </Box>
        </Box>
      ) : (
        <InputPrompt
          message={activePrompt.message}
          {...(activePrompt.defaultValue !== undefined
            ? { defaultValue: activePrompt.defaultValue }
            : {})}
          {...(activePrompt.validate ? { validate: activePrompt.validate } : {})}
          onSubmit={(value) => activePrompt.resolve(value)}
        />
      )}
      <Footer hint="↑↓ navegar · ⏎ confirmar · Ctrl-C cancelar" />
    </Box>
  );
}
