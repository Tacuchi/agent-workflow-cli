import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { selfCleanLegacy } from "../../../application/self/clean-legacy.js";
import { selfInstallHooks } from "../../../application/self/install-hooks.js";
import { type InstallTarget, selfInstallSkill } from "../../../application/self/install-skill.js";
import { selfClearPluginCache } from "../../../application/self/plugin-cache-clear.js";
import { selfUninstallSkill } from "../../../application/self/uninstall-skill.js";
import { selfUninstall } from "../../../application/self/uninstall.js";
import type { ParsedArgs } from "../../parser.js";
import type { CliContext } from "../../types.js";
import { PageHead } from "../components/page-head.js";
import { Pill } from "../components/pill.js";
import { useInputLock } from "../input-lock.js";
import { colors, icons } from "../theme.js";

export interface SkillsTabProps {
  ctx: CliContext;
  isActive: boolean;
  onToast?: (msg: { tone: "ok" | "info" | "err"; title: string; body?: string }) => void;
}

interface TargetSpec {
  kind: "host";
  id: InstallTarget;
  label: string;
}

interface SkillState {
  id: InstallTarget;
  label: string;
  installed: boolean;
  hooks_installed: boolean;
  hooks_supported: boolean;
  path: string;
}

type SkillAction = "install-full" | "uninstall-full" | "clean-cache" | "clean-legacy";

type Mode = { kind: "list" } | { kind: "actions" };

const HOOKS_SUPPORTED_TARGETS: ReadonlySet<InstallTarget> = new Set(["claude"]);

interface SkillActionDef {
  id: "install" | "uninstall";
  label: (state: "installed" | "missing") => string;
  danger?: boolean;
  availableWhen: "always" | "installed";
}

const ACTION_DEFS: readonly SkillActionDef[] = [
  {
    id: "install",
    label: (state) => (state === "installed" ? "Reinstalar" : "Instalar"),
    availableWhen: "always",
  },
  {
    id: "uninstall",
    label: () => "Desinstalar",
    danger: true,
    availableWhen: "installed",
  },
];

/**
 * SkillsTab — split view con sub-mode actions.
 *
 * - `list` mode: cursor en lista de hosts. ↑↓ navega · ⏎ entra a actions.
 * - `actions` mode: cursor en lista de acciones del host activo.
 *   ↑↓ navega · ⏎ aplica · Esc vuelve.
 *
 * Acciones:
 *  - Instalar/Reinstalar — encadena clean-legacy + clean-cache + install-full.
 *  - Desinstalar — encadena uninstall-full + clean-cache. Solo disponible si instalado.
 */
export function SkillsTab({ ctx, isActive, onToast }: SkillsTabProps) {
  const [skills, setSkills] = useState<SkillState[]>([]);
  const [cursor, setCursor] = useState(0);
  const [actionCursor, setActionCursor] = useState(0);
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const [busy, setBusy] = useState<string | null>(null);
  const startedRef = useRef(false);
  const { lock, unlock } = useInputLock();

  useEffect(() => {
    if (busy) lock();
    else unlock();
  }, [busy, lock, unlock]);

  useEffect(() => () => unlock(), [unlock]);

  const refresh = useCallback(async () => {
    const home = ctx.env.homeDir();
    const settingsPath = `${home}/.claude/settings.json`;
    let hooksInstalled = false;
    if (await ctx.fs.exists(settingsPath)) {
      try {
        const parsed = JSON.parse(await ctx.fs.readText(settingsPath));
        hooksInstalled =
          typeof parsed === "object" &&
          parsed !== null &&
          "hooks" in parsed &&
          typeof (parsed as { hooks?: unknown }).hooks === "object" &&
          Object.keys((parsed as { hooks: object }).hooks).length > 0;
      } catch {
        hooksInstalled = false;
      }
    }

    const next: SkillState[] = [
      {
        id: "claude",
        label: "Claude Code",
        installed: await ctx.fs.exists(`${home}/.claude/skills/agent-workflow`),
        hooks_installed: hooksInstalled,
        hooks_supported: HOOKS_SUPPORTED_TARGETS.has("claude"),
        path: "~/.claude/skills/agent-workflow/",
      },
      {
        id: "codex",
        label: "Codex",
        installed: await ctx.fs.exists(`${home}/.codex/skills/agent-workflow`),
        hooks_installed: false,
        hooks_supported: HOOKS_SUPPORTED_TARGETS.has("codex"),
        path: "~/.codex/skills/agent-workflow/",
      },
      {
        id: "warp",
        label: "Warp Terminal",
        installed: await ctx.fs.exists(`${home}/.warp/skills/agent-workflow`),
        hooks_installed: false,
        hooks_supported: HOOKS_SUPPORTED_TARGETS.has("warp"),
        path: "~/.warp/skills/agent-workflow/",
      },
    ];
    setSkills(next);
    setCursor((c) => Math.min(Math.max(0, c), Math.max(0, next.length - 1)));
  }, [ctx]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void refresh();
  }, [refresh]);

  const installedCount = skills.filter((s) => s.installed).length;
  const totalCount = skills.length;

  const currentTarget: TargetSpec | null = useMemo(() => {
    const host = skills[cursor];
    if (!host) return null;
    return { kind: "host", id: host.id, label: host.label };
  }, [cursor, skills]);

  const focusedHost: SkillState | null = useMemo(() => {
    if (!currentTarget) return null;
    return skills.find((s) => s.id === currentTarget.id) ?? null;
  }, [currentTarget, skills]);

  const stateOfTarget: "installed" | "missing" = focusedHost?.installed ? "installed" : "missing";

  // Acciones disponibles según el estado.
  const availableActions = useMemo(
    () => ACTION_DEFS.filter((a) => a.availableWhen === "always" || stateOfTarget === "installed"),
    [stateOfTarget],
  );

  const runComposite = useCallback(
    async (kind: "install" | "uninstall", target: TargetSpec) => {
      const steps: SkillAction[] =
        kind === "install"
          ? ["clean-legacy", "clean-cache", "install-full"]
          : ["uninstall-full", "clean-cache"];
      const startLabel =
        kind === "install" ? `instalando en ${target.label}…` : `desinstalando de ${target.label}…`;
      setBusy(startLabel);
      try {
        for (const step of steps) {
          setBusy(buildBusyLabel(step, target.label));
          const result = await dispatchAction(step, target, ctx);
          if (!result.ok) {
            const failMsg = result.error?.message;
            onToast?.(
              failMsg !== undefined
                ? { tone: "err", title: `Falló en paso ${step}`, body: failMsg }
                : { tone: "err", title: `Falló en paso ${step}` },
            );
            await refresh();
            return;
          }
        }
        const finalAction: SkillAction = kind === "install" ? "install-full" : "uninstall-full";
        onToast?.({ tone: "ok", title: buildSuccessMessage(finalAction, target) });
        await refresh();
      } catch (err) {
        onToast?.({ tone: "err", title: "Error", body: (err as Error).message });
      } finally {
        setBusy(null);
      }
    },
    [ctx, refresh, onToast],
  );

  // input — list mode (cursor en la lista de hosts)
  useInput(
    (_input, key) => {
      if (!isActive || busy || mode.kind !== "list") return;
      if (key.upArrow) {
        setCursor((c) => Math.max(0, c - 1));
        setActionCursor(0);
        return;
      }
      if (key.downArrow) {
        setCursor((c) => (skills.length === 0 ? 0 : Math.min(skills.length - 1, c + 1)));
        setActionCursor(0);
        return;
      }
      if (key.return && currentTarget) {
        setActionCursor(0);
        setMode({ kind: "actions" });
      }
    },
    { isActive },
  );

  // input — actions mode (cursor en lista de acciones del detail panel)
  useInput(
    (_input, key) => {
      if (!isActive || busy || mode.kind !== "actions") return;
      if (key.upArrow) {
        setActionCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.downArrow) {
        setActionCursor((c) => Math.min(availableActions.length - 1, c + 1));
        return;
      }
      if (key.escape) {
        setMode({ kind: "list" });
        return;
      }
      if (key.return && currentTarget) {
        const def = availableActions[actionCursor];
        if (!def) return;
        void runComposite(def.id, currentTarget);
        setMode({ kind: "list" });
      }
    },
    { isActive },
  );

  const inActionMode = mode.kind === "actions";

  return (
    <Box flexDirection="column">
      <PageHead
        title="Skills"
        count={{
          label: `${installedCount}/${totalCount}`,
          tone: installedCount === totalCount && totalCount > 0 ? "ok" : "muted",
        }}
      />

      <Box>
        {/* Panel izquierdo: hosts */}
        <Box
          flexDirection="column"
          minWidth={32}
          marginRight={1}
          borderStyle="round"
          borderColor={inActionMode ? colors.borderFaint : colors.borderActive}
          paddingX={1}
        >
          <Text color={colors.fgMoreSubtle}>HOSTS</Text>
          {skills.map((s, i) => (
            <HostRow
              key={s.id}
              label={s.label}
              note={s.installed ? s.path : "no instalado"}
              hooks={s.hooks_installed}
              selected={cursor === i}
              dimmed={inActionMode}
              state={s.installed ? "ok" : "missing"}
            />
          ))}
        </Box>

        {/* Panel derecho: detalle + acciones */}
        <Box
          flexDirection="column"
          flexGrow={1}
          borderStyle="round"
          borderColor={inActionMode ? colors.borderActive : colors.borderFaint}
          paddingX={1}
        >
          <Text color={colors.fgMoreSubtle}>DETALLE</Text>
          {currentTarget && focusedHost ? (
            <>
              <Box>
                <Text color={colors.fgBright} bold>
                  {currentTarget.label}
                </Text>
                <Box marginLeft={1}>
                  <Pill tone={stateOfTarget === "installed" ? "ok" : "muted"}>
                    {stateOfTarget === "installed" ? "instalado" : "no instalado"}
                  </Pill>
                </Box>
              </Box>

              <Box marginTop={1} flexDirection="column">
                <Text color={colors.info}>{focusedHost.path}</Text>
                {focusedHost.hooks_supported && focusedHost.hooks_installed ? (
                  <Box marginTop={1}>
                    <Pill tone="info">hooks activos</Pill>
                  </Box>
                ) : null}
              </Box>

              <Box marginTop={1} flexDirection="column">
                {availableActions.map((a, i) => (
                  <ActionRow
                    key={a.id}
                    label={a.label(stateOfTarget)}
                    danger={a.danger === true}
                    active={inActionMode && i === actionCursor}
                  />
                ))}
              </Box>
              <Text color={colors.fgFaint}>
                {stateOfTarget === "installed"
                  ? "reinstalar encadena clean-legacy + clean-cache + install · desinstalar encadena uninstall + clean-cache"
                  : "instalar encadena clean-legacy + clean-cache + install"}
              </Text>
            </>
          ) : (
            <Text color={colors.fgFaint}>(seleccioná un host)</Text>
          )}

          {busy ? (
            <Box marginTop={1}>
              <Text color={colors.warning}>
                {icons.spinner} {busy}
              </Text>
            </Box>
          ) : null}
        </Box>
      </Box>

      <Box marginTop={1}>
        <Text color={colors.fgFaint}>
          {inActionMode
            ? "↑↓ navegar acciones · ⏎ aplicar · esc volver"
            : "↑↓ navegar hosts · ⏎ ver acciones"}
        </Text>
      </Box>
    </Box>
  );
}

// ===== sub-components =====

function HostRow({
  label,
  note,
  hooks,
  selected,
  dimmed,
  state,
}: {
  label: string;
  note: string;
  hooks?: boolean;
  selected: boolean;
  dimmed: boolean;
  state: "ok" | "missing";
}) {
  const focused = selected && !dimmed;
  const stateColor = state === "ok" ? colors.success : colors.fgFaint;
  return (
    <Box>
      <Text color={focused ? colors.accent : colors.fgFaint} {...(focused ? { bold: true } : {})}>
        {selected ? "▸" : " "}
      </Text>
      <Text> </Text>
      <Box flexGrow={1} flexDirection="column">
        <Box>
          <Text
            color={focused ? colors.fgBright : colors.fgSubtle}
            {...(focused ? { bold: true, inverse: true } : {})}
          >
            {focused ? ` ${label} ` : label}
          </Text>
          {hooks ? (
            <Box marginLeft={1}>
              <Pill tone="info">hooks</Pill>
            </Box>
          ) : null}
        </Box>
        <Text color={colors.fgFaint}>{note}</Text>
      </Box>
      <Text color={stateColor} bold>
        {state === "ok" ? icons.check : icons.cross}
      </Text>
    </Box>
  );
}

function ActionRow({
  label,
  danger,
  active,
}: {
  label: string;
  danger: boolean;
  active: boolean;
}) {
  const cursorColor = active ? (danger ? colors.error : colors.accent) : colors.fgFaint;
  const labelColor = danger ? colors.error : active ? colors.fgBright : colors.fgSubtle;
  return (
    <Box>
      <Text color={cursorColor} {...(active ? { bold: true } : {})}>
        {active ? "▸" : " "}
      </Text>
      <Text> </Text>
      <Text color={labelColor} {...(active ? { bold: true, inverse: true } : {})}>
        {active ? ` ${label} ` : label}
      </Text>
    </Box>
  );
}

// ===== helpers (preserved) =====

function buildArgsFor(action: SkillAction, target: TargetSpec): ParsedArgs {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  values.set("target", target.id);
  if (action === "install-full") flags.add("--force");
  if (action === "clean-cache") values.set("plugin", "agent-workflow");
  return {
    rest: [actionToSubcommand(action)],
    plugin: {},
    flags,
    values,
    valuesMulti: new Map(),
  };
}

function actionToSubcommand(action: SkillAction): string {
  switch (action) {
    case "install-full":
      return "install-skill";
    case "uninstall-full":
      return "uninstall";
    case "clean-cache":
      return "clean-cache";
    case "clean-legacy":
      return "clean-legacy";
  }
}

async function dispatchAction(action: SkillAction, target: TargetSpec, ctx: CliContext) {
  const args = buildArgsFor(action, target);
  switch (action) {
    case "install-full":
      return selfInstallSkill(args, ctx);
    case "uninstall-full":
      return selfUninstall(args, ctx);
    case "clean-cache":
      return selfClearPluginCache(args, ctx);
    case "clean-legacy":
      return selfCleanLegacy(args, ctx);
  }
}

function buildBusyLabel(action: SkillAction, label: string): string {
  switch (action) {
    case "install-full":
      return `install completa en ${label}…`;
    case "uninstall-full":
      return `uninstall completa en ${label}…`;
    case "clean-cache":
      return `limpiando caché en ${label}…`;
    case "clean-legacy":
      return `removiendo legacy skills en ${label}…`;
  }
}

function buildSuccessMessage(action: SkillAction, target: TargetSpec): string {
  const t = target.label;
  switch (action) {
    case "install-full":
      return `Install completa OK en ${t}.`;
    case "uninstall-full":
      return `Uninstall completa OK en ${t}.`;
    case "clean-cache":
      return `Caché limpiada en ${t}.`;
    case "clean-legacy":
      return `Legacy skills removidos de ${t}.`;
  }
}

// Mantenemos imports para uso futuro de hooks/skill-only (no usados hoy).
void selfInstallHooks;
void selfUninstallSkill;
