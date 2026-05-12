import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import { type InstallTarget, selfInstallSkill } from "../../../application/self/install-skill.js";
import { selfUninstallSkill } from "../../../application/self/uninstall-skill.js";
import type { ParsedArgs } from "../../parser.js";
import type { CliContext } from "../../types.js";
import {
  type MenuItem,
  type MenuItemTrailing,
  SectionedMenu,
} from "../components/sectioned-menu.js";
import { Toast, type ToastTone } from "../components/toast.js";
import { useInputLock } from "../input-lock.js";
import { type ColorName, colors, icons } from "../theme.js";

export interface SkillsTabProps {
  ctx: CliContext;
  isActive: boolean;
}

interface SkillState {
  id: InstallTarget;
  label: string;
  installed: boolean;
  path: string;
}

type Mode = { kind: "idle" } | { kind: "action-menu"; target: SkillState };

type SkillAction = "install" | "uninstall";

const INSTALLED_TRAILING: MenuItemTrailing = {
  icon: icons.check,
  color: colors.success as ColorName,
  text: "instalado",
};

const NOT_INSTALLED_TRAILING: MenuItemTrailing = {
  icon: icons.cross,
  color: colors.fgMoreSubtle as ColorName,
  text: "no instalado",
};

function buildActionMenuItems(skill: SkillState): MenuItem<SkillAction>[] {
  const items: MenuItem<SkillAction>[] = [
    {
      kind: "item",
      label: skill.installed ? "Reinstalar / actualizar" : "Instalar",
      value: "install",
      trailing: skill.installed ? INSTALLED_TRAILING : NOT_INSTALLED_TRAILING,
    },
  ];
  if (skill.installed) {
    items.push({ kind: "item", label: "Desinstalar", value: "uninstall" });
  }
  return items;
}

export function SkillsTab({ ctx, isActive }: SkillsTabProps) {
  const [skills, setSkills] = useState<SkillState[]>([]);
  const [cursor, setCursor] = useState(0);
  const [mode, setMode] = useState<Mode>({ kind: "idle" });
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ tone: ToastTone; message: string } | null>(null);
  const startedRef = useRef(false);
  const { lock, unlock } = useInputLock();

  useEffect(() => {
    if (mode.kind === "idle") {
      unlock();
    } else {
      lock();
      setToast(null);
    }
  }, [mode, lock, unlock]);

  useEffect(() => {
    return () => unlock();
  }, [unlock]);

  const refresh = useCallback(async () => {
    const home = ctx.env.homeDir();
    const next: SkillState[] = [
      {
        id: "claude",
        label: "Claude Code",
        installed: await ctx.fs.exists(`${home}/.claude/skills/agent-workflow`),
        path: "~/.claude/skills/agent-workflow/",
      },
      {
        id: "codex",
        label: "Codex",
        installed: await ctx.fs.exists(`${home}/.codex/skills/agent-workflow`),
        path: "~/.codex/skills/agent-workflow/",
      },
      {
        id: "warp",
        label: "Warp Terminal",
        installed: await ctx.fs.exists(`${home}/.warp/skills/agent-workflow`),
        path: "~/.warp/skills/agent-workflow/",
      },
    ];
    setSkills(next);
    setCursor((c) => Math.min(Math.max(0, next.length - 1), Math.max(0, c)));
  }, [ctx]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void refresh();
  }, [refresh]);

  const runAction = useCallback(
    async (action: SkillAction, target: InstallTarget, label: string) => {
      setBusy(label);
      setToast(null);
      try {
        const args: ParsedArgs = {
          rest: [action === "install" ? "install-skill" : "uninstall-skill"],
          plugin: {},
          flags: new Set(action === "install" ? ["--force"] : []),
          values: new Map([["target", target]]),
          valuesMulti: new Map(),
        };
        const result =
          action === "install"
            ? await selfInstallSkill(args, ctx)
            : await selfUninstallSkill(args, ctx);
        if (result.ok) {
          setToast({
            tone: "success",
            message:
              action === "install"
                ? `Skill instalada/actualizada en ${target}.`
                : `Skill desinstalada de ${target}.`,
          });
        } else {
          setToast({ tone: "error", message: result.error?.message ?? "La acción falló." });
        }
        await refresh();
      } catch (err) {
        setToast({ tone: "error", message: (err as Error).message });
      } finally {
        setBusy(null);
      }
    },
    [ctx, refresh],
  );

  useInput(
    (input, key) => {
      if (!isActive || busy || mode.kind !== "idle") return;
      if (key.upArrow) {
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.downArrow) {
        setCursor((c) => (skills.length === 0 ? 0 : Math.min(skills.length - 1, c + 1)));
        return;
      }
      if (key.return) {
        const target = skills[cursor];
        if (target) setMode({ kind: "action-menu", target });
      }
      // 'i'/'I' ya no se manejan: la instalación se hace por target desde el menu de acciones.
      void input;
    },
    { isActive },
  );

  useInput(
    (_, key) => {
      if (!isActive) return;
      if (mode.kind !== "action-menu") return;
      if (key.escape) setMode({ kind: "idle" });
    },
    { isActive },
  );

  const handleActionSelect = useCallback(
    (action: SkillAction) => {
      if (mode.kind !== "action-menu") return;
      const { id, label } = mode.target;
      setMode({ kind: "idle" });
      const busyLabel =
        action === "install" ? `instalando en ${label}…` : `desinstalando de ${label}…`;
      void runAction(action, id, busyLabel);
    },
    [mode, runAction],
  );

  if (mode.kind === "action-menu") {
    return (
      <Box flexDirection="column">
        <Text color={colors.fg} bold>
          Skill {ctx.runtime.binName}
        </Text>
        <Box marginTop={1}>
          <Text color={colors.fgSubtle}>
            {icons.bullet} acciones para{" "}
            <Text color={colors.fg} bold>
              {mode.target.label}
            </Text>
          </Text>
        </Box>
        <Box marginTop={1}>
          <SectionedMenu
            items={buildActionMenuItems(mode.target)}
            onSelect={handleActionSelect}
            isActive={isActive}
          />
        </Box>
        <Box marginTop={1}>
          <Text color={colors.fgMoreSubtle}>Esc para cerrar sin aplicar.</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text color={colors.fg} bold>
        Skill {ctx.runtime.binName}
      </Text>
      <Box marginTop={1} flexDirection="column">
        {skills.map((s, i) => {
          const focused = isActive && i === cursor;
          return (
            <Box key={s.id}>
              <Text color={focused ? colors.primary : colors.fgMoreSubtle} bold={focused}>
                {focused ? icons.focusBullet : " "}{" "}
              </Text>
              <Text color={s.installed ? colors.success : colors.fgMoreSubtle} bold>
                {s.installed ? icons.check : icons.cross}{" "}
              </Text>
              <Text color={focused ? colors.fg : colors.fgSubtle} bold={focused}>
                {s.label}
              </Text>
              <Text color={colors.fgMoreSubtle}> · </Text>
              <Text color={colors.fgSubtle}>{s.path}</Text>
            </Box>
          );
        })}
      </Box>
      {busy ? (
        <Box marginTop={1}>
          <Text color={colors.warning}>
            {icons.spinner} {busy}
          </Text>
        </Box>
      ) : null}
      {toast ? <Toast tone={toast.tone} message={toast.message} /> : null}
    </Box>
  );
}
