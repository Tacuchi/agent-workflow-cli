import { Box, Text, useInput } from "ink";
import { useCallback, useState } from "react";
import { type HubInitFuente, runHubInit } from "../../../application/hub-init-service.js";
import type { CliContext } from "../../types.js";
import { colors, icons } from "../theme.js";
import { dedupeAlias, deriveAlias } from "./hub-init-alias.js";
import { InputPrompt } from "./input-prompt.js";
import { SectionHead } from "./section-head.js";

const DEFAULT_MAIN_BRANCH = "certificacion";

/**
 * Form nativo en ink para inicializar un hub. Recolecta proyecto + fuentes (≥2)
 * + rama base DENTRO del TUI y corre `runHubInit` in-process. No hace handoff a
 * inquirer (la causa del crash en Windows post-teardown de ink). El alias de
 * cada fuente se infiere del nombre de su carpeta. Escribe el bloque y SIEMPRE
 * configura la visibilidad multi-root (settings.local.json + config.toml, gitignored).
 */
type Step =
  | { kind: "proyecto" }
  | { kind: "fuente"; proyecto: string; fuentes: HubInitFuente[] }
  | { kind: "rama"; proyecto: string; fuentes: HubInitFuente[] }
  | { kind: "working"; proyecto: string; fuentes: HubInitFuente[]; mainBranch: string }
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
      fuentes: HubInitFuente[],
      mainBranch: string,
      workingBranch: string,
    ) => {
      setStep({ kind: "busy", label: `creando hub · ${fuentes.length} fuentes…` });
      try {
        // La rama de trabajo se aplica a TODAS las fuentes (patrón común: una feature
        // branch compartida). Vacía = sin rama de trabajo (queda solo la rama base).
        const workingBranches = workingBranch
          ? Object.fromEntries(fuentes.map((f) => [f.alias, workingBranch]))
          : {};
        const result = await runHubInit(ctx.fs, ctx.env, ctx.paths, {
          proyecto,
          fuentes,
          workingBranches,
          mainBranch,
        });
        if ("error" in result) {
          onDone({ ok: false, summary: result.hint ?? result.error });
          return;
        }
        onDone({
          ok: result.ok,
          summary: result.ok
            ? `Hub creado · ${fuentes.length} fuentes · visibilidad configurada`
            : "hub-init no completó",
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
          label="Initialize as hub"
          hint="Paso 1 · nombre"
          rightAction="⏎ siguiente · esc cancela"
        />
        <Box marginLeft={2} marginTop={1}>
          <InputPrompt
            key="proyecto"
            message="Nombre del proyecto:"
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
          label="Initialize as hub"
          hint={`Paso 2 · fuente #${n} (mín 2)`}
          rightAction="⏎ agrega · vacío = terminar · esc cancela"
        />
        <FuenteList fuentes={step.fuentes} />
        <Box marginLeft={2} marginTop={1}>
          <InputPrompt
            key={`fuente-${step.fuentes.length}`}
            message={`Fuente #${n} · path (vacío = terminar):`}
            validate={(v) =>
              v.trim().length > 0 || step.fuentes.length >= 2 || "Necesitás al menos 2 fuentes"
            }
            onSubmit={(v) => {
              const path = v.trim();
              if (path === "") {
                if (step.fuentes.length >= 2) {
                  setStep({ kind: "rama", proyecto: step.proyecto, fuentes: step.fuentes });
                }
                return;
              }
              const seen = new Set(step.fuentes.map((f) => f.alias));
              const fuente: HubInitFuente = { alias: dedupeAlias(deriveAlias(path), seen), path };
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
          label="Initialize as hub"
          hint="Paso 3 · rama base"
          rightAction="⏎ siguiente · esc cancela"
        />
        <FuenteList fuentes={step.fuentes} />
        <Box marginLeft={2} marginTop={1}>
          <InputPrompt
            key="rama"
            message="Rama base:"
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
        label="Initialize as hub"
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

function FuenteList({ fuentes }: { fuentes: HubInitFuente[] }) {
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
