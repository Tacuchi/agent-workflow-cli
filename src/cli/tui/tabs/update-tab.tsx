import { Box, Text } from "ink";
import { useCallback, useMemo, useState } from "react";
import type { CliContext } from "../../types.js";
import { type MenuItem, SectionedMenu } from "../components/sectioned-menu.js";
import { Toast, type ToastTone } from "../components/toast.js";
import { colors, icons } from "../theme.js";

export interface UpdateTabProps {
  ctx: CliContext;
  version: string;
  isActive: boolean;
  onRequestUpdate: () => void;
}

type UpdateAction = "check" | "install";

interface CheckResult {
  status: "uptodate" | "outdated" | "error";
  latest?: string;
  message: string;
}

function buildMenuItems(check: CheckResult | null): MenuItem<UpdateAction>[] {
  const items: MenuItem<UpdateAction>[] = [
    { kind: "item", label: "Buscar actualizaciones", value: "check" },
  ];
  if (check?.status === "outdated") {
    const target = check.latest
      ? `Actualizar a v${check.latest} (npm install)`
      : "Actualizar ahora (npm install)";
    items.push({ kind: "item", label: target, value: "install" });
  }
  return items;
}

export function UpdateTab({ ctx, version, isActive, onRequestUpdate }: UpdateTabProps) {
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [busy, setBusy] = useState(false);

  const runCheck = useCallback(async () => {
    setBusy(true);
    setCheck(null);
    try {
      const result = await ctx.process.run("npm", ["view", ctx.runtime.packageName, "version"], {});
      if (result.code !== 0) {
        setCheck({
          status: "error",
          message: `npm view falló (exit ${result.code}): ${result.stderr.trim() || "sin detalle"}`,
        });
        return;
      }
      const latest = result.stdout.trim();
      if (!latest) {
        setCheck({ status: "error", message: "npm view devolvió output vacío." });
        return;
      }
      if (latest === version) {
        setCheck({
          status: "uptodate",
          latest,
          message: `Ya estás en la última versión (v${version}).`,
        });
      } else {
        setCheck({
          status: "outdated",
          latest,
          message: `Hay una versión más reciente disponible: v${latest} (actualmente v${version}).`,
        });
      }
    } catch (err) {
      setCheck({ status: "error", message: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }, [ctx, version]);

  const handleSelect = useCallback(
    (action: UpdateAction) => {
      if (busy) return;
      if (action === "check") {
        void runCheck();
      } else if (action === "install") {
        onRequestUpdate();
      }
    },
    [busy, runCheck, onRequestUpdate],
  );

  const menuItems = useMemo(() => buildMenuItems(check), [check]);

  return (
    <Box flexDirection="column">
      <Text color={colors.fg} bold>
        Actualizar CLI
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Box>
          <Text color={colors.fg}>versión actual:</Text>
          <Text> </Text>
          <Text color={colors.accent} bold>
            v{version}
          </Text>
        </Box>
        <Box>
          <Text color={colors.fgSubtle}>paquete: </Text>
          <Text color={colors.fgSubtle}>{ctx.runtime.packageName}</Text>
        </Box>
      </Box>

      <Box marginTop={1}>
        <SectionedMenu items={menuItems} onSelect={handleSelect} isActive={isActive && !busy} />
      </Box>

      {busy ? (
        <Box marginTop={1}>
          <Text color={colors.warning}>{icons.spinner} consultando npm registry...</Text>
        </Box>
      ) : null}

      {check ? <CheckSummary result={check} /> : null}
    </Box>
  );
}

function CheckSummary({ result }: { result: CheckResult }) {
  const tone: ToastTone =
    result.status === "uptodate" ? "success" : result.status === "outdated" ? "info" : "error";
  return <Toast tone={tone} message={result.message} />;
}
