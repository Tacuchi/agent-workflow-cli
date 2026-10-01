import { Box, Text, useInput } from "ink";
import { useCallback, useState } from "react";
import { type HubSource, runHubInit } from "../../../application/hub-init-service.js";
import type { CliContext } from "../../types.js";
import { colors, icons } from "../theme.js";
import { dedupeAlias, deriveAlias } from "./hub-init-alias.js";
import { InputPrompt } from "./input-prompt.js";
import { SectionHead } from "./section-head.js";

const DEFAULT_MAIN_BRANCH = "main";

/**
 * Native Ink form to configure hub sources. Collects the hub name + sources (≥1)
 * + base branch + working branch INSIDE the TUI and runs `runHubInit`
 * in-process. No handoff to inquirer (the cause of the Windows crash after
 * ink's teardown). Each source's alias is inferred from its folder name.
 * Writes the hub block and, with 2+ sources, configures multi-root
 * visibility (settings.local.json + config.toml, gitignored).
 *
 * One concept: a hub simply has 1+ sources.
 */
type Step =
  | { kind: "nombre" }
  | { kind: "fuente"; proyecto: string; fuentes: HubSource[] }
  | { kind: "rama"; proyecto: string; fuentes: HubSource[] }
  | { kind: "working"; proyecto: string; fuentes: HubSource[]; mainBranch: string }
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
  const [step, setStep] = useState<Step>({ kind: "nombre" });

  // Esc cancels at any input step (not while the hub is being written).
  useInput(
    (_input, key) => {
      if (key.escape && step.kind !== "busy") onCancel();
    },
    { isActive },
  );

  const create = useCallback(
    async (proyecto: string, fuentes: HubSource[], mainBranch: string, workingBranch: string) => {
      setStep({ kind: "busy", label: `configurando fuentes · ${fuentes.length} fuentes…` });
      try {
        // The working branch applies to ALL sources (common pattern: a shared
        // feature branch). Empty = no working branch (only the base branch remains).
        const workingBranches = workingBranch
          ? Object.fromEntries(fuentes.map((f) => [f.alias, workingBranch]))
          : {};
        const result = await runHubInit(ctx.rawFs ?? ctx.fs, ctx.env, ctx.paths, {
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
        const migration = migrationSummary(result.hub_block_files);
        onDone({
          ok: result.ok,
          summary: result.ok
            ? `Fuentes configuradas · ${fuentes.length}${multiroot}${migration}`
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

  if (step.kind === "nombre") {
    return (
      <Box flexDirection="column">
        <SectionHead
          label="Configurar fuentes"
          hint="Paso 1 · nombre"
          rightAction="⏎ siguiente · esc cancela"
        />
        <Box marginLeft={2} marginTop={1}>
          <InputPrompt
            key="nombre"
            message="Nombre del hub:"
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
          label="Configurar fuentes"
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
              const fuente: HubSource = { alias: dedupeAlias(deriveAlias(path), seen), path };
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
          label="Configurar fuentes"
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
        label="Configurar fuentes"
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

function FuenteList({ fuentes }: { fuentes: HubSource[] }) {
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

function migrationSummary(
  hubBlock: Exclude<Awaited<ReturnType<typeof runHubInit>>, { error: string }>["hub_block_files"],
): string {
  const migration =
    "migrated" in hubBlock
      ? ` · migradas ${(hubBlock.migrated ?? []).join(", ") || "ninguna"} · pendientes ${(hubBlock.not_migrated ?? []).join(", ") || "ninguna"}`
      : "";
  return migration;
}
