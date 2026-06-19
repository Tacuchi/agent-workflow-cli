import { Box, Text, useInput } from "ink";
import { useCallback, useState } from "react";
import {
  type WorkspaceSource,
  runWorkspaceInit,
} from "../../../application/workspace-init-service.js";
import type { CliContext } from "../../types.js";
import { colors, icons } from "../theme.js";
import { dedupeAlias, deriveAlias } from "./hub-init-alias.js";
import { InputPrompt } from "./input-prompt.js";
import { SectionHead } from "./section-head.js";

const DEFAULT_MAIN_BRANCH = "main";

/**
 * Form nativo en ink para inicializar un WORKSPACE. Recolecta proyecto + fuentes
 * (≥1) + rama base + rama de trabajo DENTRO del TUI y corre `runWorkspaceInit`
 * in-process. No hace handoff a inquirer (la causa del crash en Windows
 * post-teardown de ink). El alias de cada fuente se infiere del nombre de su
 * carpeta. Escribe el bloque WORKSPACE y, con 2+ fuentes, configura la
 * visibilidad multi-root (settings.local.json + config.toml, gitignored).
 *
 * No hay distinción project/hub: un workspace simplemente tiene 1+ fuentes.
 */
type Step =
  | { kind: "proyecto" }
  | { kind: "fuente"; proyecto: string; fuentes: WorkspaceSource[] }
  | { kind: "rama"; proyecto: string; fuentes: WorkspaceSource[] }
  | { kind: "working"; proyecto: string; fuentes: WorkspaceSource[]; mainBranch: string }
  | { kind: "busy"; label: string };

export interface HubInitFormProps {
  ctx: CliContext;
  defaultProyecto: string;
  isActive?: boolean;
  onDone: (result: { ok: boolean; summary: string }) => void;
  onCancel: () => void;
}

export function HubInitForm({
  ctx,
  defaultProyecto,
  isActive = true,
  onDone,
  onCancel,
}: HubInitFormProps) {
  const [step, setStep] = useState<Step>({ kind: "proyecto" });

  // Esc cancela en cualquier paso de input (no durante la escritura).
  useInput(
    (_input, key) => {
      if (key.escape && step.kind !== "busy") onCancel();
    },
    { isActive },
  );

  const create = useCallback(
    async (
      proyecto: string,
      fuentes: WorkspaceSource[],
      mainBranch: string,
      workingBranch: string,
    ) => {
      setStep({ kind: "busy", label: `creando workspace · ${fuentes.length} fuentes…` });
      try {
        // La rama de trabajo se aplica a TODAS las fuentes (patrón común: una feature
        // branch compartida). Vacía = sin rama de trabajo (queda solo la rama base).
        const workingBranches = workingBranch
          ? Object.fromEntries(fuentes.map((f) => [f.alias, workingBranch]))
          : {};
        const result = await runWorkspaceInit(ctx.fs, ctx.env, ctx.paths, {
          proyecto,
          sources: fuentes,
          workingBranches,
          mainBranch,
        });
        if ("error" in result) {
          onDone({ ok: false, summary: result.hint ?? result.error });
          return;
        }
        const multiroot = fuentes.length > 1 ? " · visibilidad configurada" : "";
        onDone({
          ok: result.ok,
          summary: result.ok
            ? `Workspace creado · ${fuentes.length} fuentes${multiroot}`
            : "workspace-init no completó",
        });
      } catch (err) {
        onDone({ ok: false, summary: (err as Error).message });
      }
    },
    [ctx, onDone],
  );

  if (step.kind === "busy") {
    return (
      <Box>
        <Text color={colors.warn}>
          {icons.spinner} {step.label}
        </Text>
      </Box>
    );
  }

  if (step.kind === "proyecto") {
    return (
      <Box flexDirection="column">
        <SectionHead
          label="Initialize workspace"
          hint="Paso 1 · nombre"
          rightAction="⏎ siguiente · esc cancela"
        />
        <Box marginLeft={2} marginTop={1}>
          <InputPrompt
            key="proyecto"
            message="Nombre del workspace:"
            defaultValue={defaultProyecto}
            validate={(v) => v.trim().length > 0 || "El nombre no puede estar vacío"}
            onSubmit={(v) => setStep({ kind: "fuente", proyecto: v.trim(), fuentes: [] })}
            isActive={isActive}
          />
        </Box>
      </Box>
    );
  }

  if (step.kind === "fuente") {
    const n = step.fuentes.length + 1;
    return (
      <Box flexDirection="column">
        <SectionHead
          label="Initialize workspace"
          hint={`Paso 2 · fuente #${n} (mín 1)`}
          rightAction="⏎ agrega · vacío = terminar · esc cancela"
        />
        <FuenteList fuentes={step.fuentes} />
        <Box marginLeft={2} marginTop={1}>
          <InputPrompt
            key={`fuente-${step.fuentes.length}`}
            message={`Fuente #${n} · path (vacío = terminar):`}
            validate={(v) =>
              v.trim().length > 0 || step.fuentes.length >= 1 || "Necesitás al menos 1 fuente"
            }
            onSubmit={(v) => {
              const path = v.trim();
              if (path === "") {
                if (step.fuentes.length >= 1) {
                  setStep({ kind: "rama", proyecto: step.proyecto, fuentes: step.fuentes });
                }
                return;
              }
              const seen = new Set(step.fuentes.map((f) => f.alias));
              const fuente: WorkspaceSource = { alias: dedupeAlias(deriveAlias(path), seen), path };
              setStep({
                kind: "fuente",
                proyecto: step.proyecto,
                fuentes: [...step.fuentes, fuente],
              });
            }}
            isActive={isActive}
          />
        </Box>
      </Box>
    );
  }

  if (step.kind === "rama") {
    return (
      <Box flexDirection="column">
        <SectionHead
          label="Initialize workspace"
          hint="Paso 3 · rama principal"
          rightAction="⏎ siguiente · esc cancela"
        />
        <FuenteList fuentes={step.fuentes} />
        <Box marginLeft={2} marginTop={1}>
          <InputPrompt
            key="rama"
            message="Rama principal:"
            defaultValue={DEFAULT_MAIN_BRANCH}
            validate={(v) => v.trim().length > 0 || "La rama no puede estar vacía"}
            onSubmit={(v) =>
              setStep({
                kind: "working",
                proyecto: step.proyecto,
                fuentes: step.fuentes,
                mainBranch: v.trim(),
              })
            }
            isActive={isActive}
          />
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <SectionHead
        label="Initialize workspace"
        hint="Paso 4 · rama de trabajo"
        rightAction="⏎ crear · vacío = sin rama · esc cancela"
      />
      <FuenteList fuentes={step.fuentes} />
      <Box marginLeft={2} marginTop={1}>
        <InputPrompt
          key="working"
          message="Rama de trabajo (vacío = sin rama):"
          onSubmit={(v) => void create(step.proyecto, step.fuentes, step.mainBranch, v.trim())}
          isActive={isActive}
        />
      </Box>
    </Box>
  );
}

function FuenteList({ fuentes }: { fuentes: WorkspaceSource[] }) {
  if (fuentes.length === 0) return null;
  return (
    <Box marginLeft={2} marginTop={1} flexDirection="column">
      {fuentes.map((f) => (
        <Box key={f.alias}>
          <Text color={colors.ok}>{icons.check} </Text>
          <Text color={colors.bright}>{f.alias}</Text>
          <Text color={colors.dim}> {f.path}</Text>
        </Box>
      ))}
    </Box>
  );
}
