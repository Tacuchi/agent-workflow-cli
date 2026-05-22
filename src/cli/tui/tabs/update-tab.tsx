import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CliContext } from "../../types.js";
import { PageHead } from "../components/page-head.js";
import { Pill } from "../components/pill.js";
import { colors, icons } from "../theme.js";

export interface UpdateTabProps {
  ctx: CliContext;
  version: string;
  isActive: boolean;
  onRequestUpdate: () => void;
  onToast?: (msg: { tone: "ok" | "info" | "err"; title: string; body?: string }) => void;
}

type Status = "idle" | "checking" | "uptodate" | "outdated" | "applying" | "done" | "error";

interface CheckResult {
  status: Status;
  latest?: string;
  message?: string;
}

/**
 * UpdateTab minimal — versión actual → última en una línea, acciones inline.
 *
 * Sin cards con bordes, sin section labels. Auto-check al montar.
 * Acciones: `r` buscar / `i` aplicar / `o` release notes.
 */
export function UpdateTab({ ctx, version, isActive, onRequestUpdate, onToast }: UpdateTabProps) {
  const [check, setCheck] = useState<CheckResult>({ status: "idle" });
  const startedRef = useRef(false);

  const runCheck = useCallback(async () => {
    setCheck({ status: "checking" });
    try {
      const result = await ctx.process.run("npm", ["view", ctx.runtime.packageName, "version"], {});
      if (result.code !== 0) {
        const msg = `npm view falló: ${result.stderr.trim() || "sin detalle"}`;
        setCheck({ status: "error", message: msg });
        onToast?.({ tone: "err", title: "Buscar actualización falló", body: msg });
        return;
      }
      const latest = result.stdout.trim();
      if (!latest) {
        setCheck({ status: "error", message: "npm view devolvió output vacío." });
        return;
      }
      if (latest === version) {
        setCheck({ status: "uptodate", latest });
      } else {
        setCheck({ status: "outdated", latest });
        onToast?.({
          tone: "info",
          title: "Hay una actualización disponible",
          body: `v${version} → v${latest}`,
        });
      }
    } catch (err) {
      setCheck({ status: "error", message: (err as Error).message });
    }
  }, [ctx, version, onToast]);

  // Auto-check al montar.
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void runCheck();
  }, [runCheck]);

  useInput(
    (input) => {
      if (!isActive) return;
      if (check.status === "checking" || check.status === "applying") return;
      if (input === "r" || input === "R") {
        void runCheck();
      } else if (input === "i" || input === "I") {
        if (check.status === "outdated") {
          setCheck({ ...check, status: "applying" });
          onRequestUpdate();
        }
      } else if (input === "o" || input === "O") {
        onToast?.({
          tone: "info",
          title: "Release notes",
          body: `npm: https://www.npmjs.com/package/${ctx.runtime.packageName}`,
        });
      }
    },
    { isActive },
  );

  return (
    <Box flexDirection="column">
      <PageHead title="Update" />

      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={check.status === "outdated" ? colors.borderActive : colors.borderFaint}
        paddingX={1}
        marginBottom={1}
      >
        <Text color={colors.fgMoreSubtle}>VERSIÓN</Text>
        <Box>
          <Text color={colors.fgFaint}>actual</Text>
          <Text> </Text>
          <Text color={colors.fgBright} bold>
            v{version}
          </Text>
          <Text color={colors.fgFaint}>{" → última "}</Text>
          <Text
            color={check.status === "outdated" ? colors.accent : colors.fgBright}
            {...(check.status === "outdated" ? { bold: true } : {})}
          >
            v{check.latest ?? "?"}
          </Text>
          {check.status === "outdated" ? (
            <Box marginLeft={1}>
              <Pill tone="accent">disponible</Pill>
            </Box>
          ) : check.status === "uptodate" ? (
            <Box marginLeft={1}>
              <Pill tone="ok">al día</Pill>
            </Box>
          ) : check.status === "checking" ? (
            <Box marginLeft={1}>
              <Text color={colors.fgFaint}>{icons.spinner} consultando…</Text>
            </Box>
          ) : null}
        </Box>
        <Text color={colors.fgFaint}>{ctx.runtime.packageName} · registry.npmjs.org</Text>
      </Box>

      <Box flexDirection="column" borderStyle="round" borderColor={colors.borderFaint} paddingX={1}>
        <Text color={colors.fgMoreSubtle}>ACCIONES</Text>
        <ActionKey k="r" label="buscar de nuevo" />
        <ActionKey
          k="i"
          label={`aplicar v${check.latest ?? "?"}`}
          primary={check.status === "outdated"}
          disabled={check.status !== "outdated"}
        />
        <ActionKey k="o" label="release notes" />
      </Box>

      {check.status === "applying" ? (
        <Box marginTop={1}>
          <Text color={colors.warning}>
            {icons.spinner} aplicando v{check.latest}… (npm install)
          </Text>
        </Box>
      ) : null}

      {check.status === "error" ? (
        <Box marginTop={1}>
          <Text color={colors.error}>
            {icons.cross} {check.message ?? "Error desconocido"}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

function ActionKey({
  k,
  label,
  primary,
  disabled,
}: {
  k: string;
  label: string;
  primary?: boolean;
  disabled?: boolean;
}) {
  const keyColor = disabled ? colors.fgFaint : primary ? colors.accent : colors.fgBright;
  const labelColor = disabled ? colors.fgFaint : primary ? colors.fgBright : colors.fgSubtle;
  return (
    <Box>
      <Text color={keyColor} {...(!disabled ? { bold: true } : {})}>
        {k}
      </Text>
      <Text color={colors.fgFaint}> · </Text>
      <Text color={labelColor} {...(primary && !disabled ? { bold: true } : {})}>
        {label}
      </Text>
    </Box>
  );
}
