import { Box, Text, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import { selfInstallSkill } from "../../../application/self/install-skill.js";
import type { ParsedArgs } from "../../parser.js";
import type { CliContext } from "../../types.js";
import { Toast, type ToastTone } from "../components/toast.js";
import { colors, icons } from "../theme.js";

export interface SkillsTabProps {
  ctx: CliContext;
  isActive: boolean;
}

interface SkillState {
  target: string;
  installed: boolean;
  path: string;
}

export function SkillsTab({ ctx, isActive }: SkillsTabProps) {
  const [skills, setSkills] = useState<SkillState[]>([]);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ tone: ToastTone; message: string } | null>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void refresh();
  }, []);

  async function refresh() {
    const home = ctx.env.homeDir();
    const targets: SkillState[] = [
      {
        target: "Claude Code",
        installed: await ctx.fs.exists(`${home}/.claude/skills/agent-workflow`),
        path: "~/.claude/skills/agent-workflow/",
      },
      {
        target: "Codex",
        installed: await ctx.fs.exists(`${home}/.codex/skills/agent-workflow`),
        path: "~/.codex/skills/agent-workflow/",
      },
      {
        target: "Warp Terminal",
        installed: await ctx.fs.exists(`${home}/.warp/skills/agent-workflow`),
        path: "~/.warp/skills/agent-workflow/",
      },
    ];
    setSkills(targets);
  }

  useInput(
    async (input) => {
      if (busy) return;
      if (input === "i" || input === "I") {
        setBusy(true);
        setToast(null);
        const args: ParsedArgs = {
          rest: ["install-skill"],
          plugin: {},
          flags: new Set(["--force"]),
          values: new Map(),
          valuesMulti: new Map(),
        };
        try {
          const result = await selfInstallSkill(args, ctx);
          if (result.ok) {
            setToast({
              tone: "success",
              message: "Skill instalada/actualizada en Claude, Codex y Warp.",
            });
          } else {
            setToast({ tone: "error", message: result.error?.message ?? "Falló la instalación." });
          }
          await refresh();
        } catch (err) {
          setToast({ tone: "error", message: (err as Error).message });
        } finally {
          setBusy(false);
        }
      }
    },
    { isActive },
  );

  return (
    <Box flexDirection="column">
      <Text color={colors.fg} bold>
        Skill {ctx.runtime.binName}
      </Text>
      <Box marginTop={1} flexDirection="column">
        {skills.map((s) => (
          <Box key={s.target}>
            <Text color={s.installed ? colors.success : colors.fgMoreSubtle} bold>
              {s.installed ? icons.check : icons.cross}{" "}
            </Text>
            <Text color={colors.fg}>{s.target}</Text>
            <Text color={colors.fgMoreSubtle}> · </Text>
            <Text color={colors.fgSubtle}>{s.path}</Text>
          </Box>
        ))}
      </Box>
      {busy ? (
        <Box marginTop={1}>
          <Text color={colors.warning}>{icons.spinner} instalando…</Text>
        </Box>
      ) : null}
      {toast ? <Toast tone={toast.tone} message={toast.message} /> : null}
    </Box>
  );
}
