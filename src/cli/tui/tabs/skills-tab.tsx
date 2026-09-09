// [Skills] — external-skills manager (skills.sh model): one list with badges
// (installed → unmanaged → registered → recommended), a detail that states
// INSTALLATION and RECOMMENDATION as separate facts, and one journey for every
// change: selection → preview → applying → result
// (DES-001@r7 / SCR-001@r3).
//
// Since Spec 043 there is no shortcut that mutates: every action prepares a
// proposal, the preview shows the WHOLE set with its destinations, `Back` is
// where the focus starts, and `Apply` sends that proposal's own digest as the
// approval. The result is a view — per destination, with its verification
// separate — and not a toast that scrolls a partial failure away.
//
// The list opens PROJECTED to the recommended catalog and `t` toggles to every
// detected skill (SPEC 019) — a view mode, not a second data source.
// Backed by skills-manager (reads), skills-change (prepare) and skills-apply
// (apply/recover); the `w` bundle administration lives in [Workline].

import { Box, Text, useInput, useStdout } from "ink";
import { useCallback, useMemo, useRef, useState } from "react";
import { formatTuiEvent } from "../../../application/logging/log-events.js";
import {
  type ApplyResult,
  type SkillJournal,
  applySkillChange,
  readSkillJournal,
  recoverSkillJournal,
} from "../../../application/self/skills-apply.js";
import type { SkillCuration, SkillDisposition } from "../../../application/self/skills-catalog.js";
import {
  type SkillChangeOperation,
  type SkillChangeProposal,
  type SkillChangeRequest,
  prepareSkillChange,
} from "../../../application/self/skills-change.js";
import type {
  SkillCandidate,
  SourceInventory,
} from "../../../application/self/skills-discovery.js";
import {
  REPLICA_HOST_KEYS,
  REPLICA_HOST_LABELS,
  type SkillListItem,
  canonicalSkillsRoot,
  listSkills,
  resolveSkillSource,
} from "../../../application/self/skills-manager.js";
import type { RequiredExpansion } from "../../../application/self/skills-payload.js";
import type { CliContext } from "../../types.js";
import { ConfirmBanner } from "../components/confirm-banner.js";
import { type DetailAction, DetailPanel } from "../components/detail-panel.js";
import { InputPrompt } from "../components/input-prompt.js";
import { ListRow, type MetaTone } from "../components/list-row.js";
import { notificationStackRows } from "../components/notification-stack.js";
import { PageHead } from "../components/page-head.js";
import { QuickActions } from "../components/quick-actions.js";
import { SectionHead } from "../components/section-head.js";
import { RECOMMENDED_SKILLS, SKILL_CATALOG } from "../data/recommended-skills.js";
import { useLockWhile } from "../input-lock.js";
import { type ToastBridgeInput, useNotificationItems } from "../notification-center.js";
import { rowWidth } from "../row-width.js";
import { colors, icons } from "../theme.js";
import { useListDetailKeys } from "../use-list-detail-keys.js";
import { useListWindow, windowRangeHint } from "../use-list-window.js";
import { useOnMount } from "../use-on-mount.js";

const REPLICA_LABELS = REPLICA_HOST_LABELS.join(", ");

// Rows the chrome consumes around the skills list; the window (useListWindow)
// gets what remains of the viewport:
//   app shell 16 = ScreenFrame border+paddingY 4 · HomeHeader 3 (2 rows +
//     marginBottom) · TabBar 3 (border + row) · tab content box
//     border+paddingY 4 · HomeFooter 2 (marginTop + row)
//   this tab 6 = PageHead 2 (row + marginBottom) · SectionHead 1 ·
//     QuickActions 3 (marginTop + rule + keys)
const SKILLS_LIST_RESERVED_ROWS = 22;

export interface SkillsTabProps {
  ctx: CliContext;
  isActive: boolean;
  onToast?: (msg: ToastBridgeInput) => void;
}

type ActionId = "install" | "update" | "repair" | "replace" | "uninstall" | "remove";

/** A prepared proposal owns a temp payload until it is applied or dropped. */
interface Prepared {
  proposal: SkillChangeProposal;
  release: () => Promise<void>;
}

/** What the selection screen is choosing FOR. */
interface SelectionIntent {
  operation: SkillChangeOperation;
  source: string;
  /** Managed installations this change would retire. */
  withdraw: string[];
}

type Mode =
  | { kind: "list" }
  | { kind: "detail" }
  | { kind: "confirm"; action: "uninstall" | "remove" }
  | { kind: "wizard-source"; intent: SelectionIntent }
  | {
      kind: "selection";
      intent: SelectionIntent;
      inventory: SourceInventory;
      candidates: SkillCandidate[];
      chosen: string[];
      cursor: number;
      note: string | null;
    }
  | { kind: "preview"; prepared: Prepared; cursor: number }
  | { kind: "applying"; label: string }
  | { kind: "result"; result: ApplyResult }
  | { kind: "recovery"; journal: SkillJournal; cursor: number }
  | { kind: "busy"; label: string };

// The `filtered` mode's projection: the names of the HABITUAL set, whatever
// their status — a withdrawn entry leaves it and stays reachable under `all`.
const RECOMMENDED_NAMES = new Set(RECOMMENDED_SKILLS.map((s) => s.name));

// What `Recommendation` reads for each verdict, and which ones earn a badge in
// the list: `keep`/`conditional` are the ordinary cases and stay quiet, while
// the three that ask for a decision are visible without opening the detail.
const DISPOSITION_LABEL: Record<SkillDisposition, string> = {
  keep: "keep",
  conditional: "conditional",
  repair: "repair/replace",
  candidate: "candidate",
  withdrawn: "withdrawn",
};

const BADGED_DISPOSITIONS: Partial<Record<SkillDisposition, MetaTone>> = {
  repair: "warn",
  candidate: "info",
  withdrawn: "warn",
};

// Said, never inferred: a field the review did not record is unknown, and
// unknown is not "compatible".
const UNKNOWN = "unknown";

/** Rows visible in the current mode: the whole list, or just the habitual set's. */
function projectSkills(all: SkillListItem[], showAll: boolean): SkillListItem[] {
  return showAll ? all : all.filter((s) => RECOMMENDED_NAMES.has(s.name));
}

const STATUS_GLYPH: Record<
  SkillListItem["status"],
  { glyph: string; active: boolean; tone: MetaTone }
> = {
  installed: { glyph: "◆", active: true, tone: "ok" },
  unmanaged: { glyph: "◈", active: true, tone: "warn" },
  registered: { glyph: "◇", active: false, tone: "dim" },
  recommended: { glyph: "·", active: false, tone: "info" },
};

/** The colour each per-destination status reads in: `applied` is the only one
 *  that means "done", and `failed` must never look like it. */
const RESULT_COLOR: Record<ApplyResult["destinations"][number]["status"], string> = {
  applied: colors.ok,
  pending: colors.warn,
  failed: colors.err,
  unchanged: colors.dim,
  restored: colors.accent,
};

export function SkillsTab({ ctx, isActive, onToast }: SkillsTabProps) {
  const [items, setItems] = useState<SkillListItem[]>([]);
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  // View mode, local and unpersisted: every mount opens on the catalog (SPEC 019).
  const [showAll, setShowAll] = useState(false);
  const visibleRef = useRef<SkillListItem[]>([]);
  const { stdout } = useStdout();

  const visible = useMemo(() => projectSkills(items, showAll), [items, showAll]);
  visibleRef.current = visible;

  useLockWhile(mode.kind !== "list" && mode.kind !== "detail");

  const actionsLenRef = useRef(0);

  const { cursor, setCursor, actionCursor } = useListDetailKeys({
    isActive,
    phase:
      mode.kind === "list" || mode.kind === "detail"
        ? mode.kind
        : mode.kind === "confirm"
          ? "confirm"
          : "off",
    listLen: visible.length,
    actionsLen: actionsLenRef.current,
    onAdd: () =>
      setMode({
        kind: "wizard-source",
        intent: { operation: "install", source: "", withdraw: [] },
      }),
    onOpenDetail: () => setMode({ kind: "detail" }),
    onCloseDetail: () => setMode({ kind: "list" }),
    onRunAction: (i) => {
      const entry = detailActions[i];
      if (entry) triggerAction(entry.id);
    },
    onConfirm: (yes) => {
      if (mode.kind !== "confirm" || !current) return;
      if (!yes) return setMode({ kind: "detail" });
      void prepare(
        { operation: mode.action, name: current.name },
        `preparing ${mode.action} of ${current.name}…`,
      );
    },
  });

  const notifItems = useNotificationItems();
  const listWindow = useListWindow(
    visible.length,
    cursor,
    SKILLS_LIST_RESERVED_ROWS + notificationStackRows(notifItems),
  );

  const reanchorCursor = useCallback(
    (next: SkillListItem[]) => {
      setCursor((c) => {
        const prevName = visibleRef.current[c]?.name;
        const idx = prevName === undefined ? -1 : next.findIndex((s) => s.name === prevName);
        return idx >= 0 ? idx : Math.min(Math.max(0, c), Math.max(0, next.length - 1));
      });
    },
    [setCursor],
  );

  const refresh = useCallback(async () => {
    try {
      const next = await listSkills(ctx, SKILL_CATALOG);
      reanchorCursor(projectSkills(next, showAll));
      setItems(next);
    } catch (err) {
      onToast?.({ tone: "err", title: "Error loading skills", body: (err as Error).message });
    }
  }, [ctx, onToast, reanchorCursor, showAll]);

  // On mount the tab also asks whether a previous run left an operation
  // half-applied: finding it is what makes the journal worth writing.
  useOnMount(() => {
    void (async () => {
      await refresh();
      const journal = await readSkillJournal(ctx);
      if (journal !== null) setMode({ kind: "recovery", journal, cursor: 0 });
    })();
  });

  const current = visible[cursor] ?? null;
  const installedCount = items.filter((s) => s.status === "installed").length;
  const unmanagedCount = items.filter((s) => s.status === "unmanaged").length;
  const registeredCount = items.filter((s) => s.status === "registered").length;
  const recommendedCount = items.filter((s) => s.status === "recommended").length;

  /**
   * Prepares a change and shows its preview. Nothing is applied here: this is
   * the only door to a mutation, and it opens onto a preview.
   */
  const prepare = useCallback(
    async (
      request: Parameters<typeof prepareSkillChange>[1],
      label: string,
      intent?: SelectionIntent,
    ) => {
      setMode({ kind: "busy", label });
      try {
        const outcome = await prepareSkillChange(ctx, request);
        if (outcome.status === "rejected") {
          onToast?.({
            tone: "err",
            title: "Change refused",
            body: `${outcome.rejection.code}: ${outcome.rejection.message}`,
          });
          setMode({ kind: "list" });
          return;
        }
        if (outcome.status === "needs-choice") {
          setMode({
            kind: "selection",
            intent: intent ?? {
              operation: "install",
              source: request.source ?? "",
              withdraw: request.withdraw ?? [],
            },
            inventory: outcome.inventory,
            candidates: outcome.candidates,
            chosen: [],
            cursor: 0,
            note: null,
          });
          await outcome.release();
          return;
        }
        if (outcome.status === "needs-expansion") {
          await outcome.release();
          setMode(expansionSelection(request, outcome.expansions, intent));
          return;
        }
        setMode({
          kind: "preview",
          prepared: { proposal: outcome.proposal, release: outcome.release },
          // `Back` is where the focus starts: Apply is an explicit move.
          cursor: 0,
        });
      } catch (err) {
        onToast?.({ tone: "err", title: "Error", body: (err as Error).message });
        setMode({ kind: "list" });
      }
    },
    [ctx, onToast],
  );

  /** Re-opens the selection with the expansion the payload requires. */
  const expansionSelection = useCallback(
    (
      request: Parameters<typeof prepareSkillChange>[1],
      expansions: RequiredExpansion[],
      intent?: SelectionIntent,
    ): Mode => {
      const chosen = [...(request.paths ?? [])];
      const candidates: SkillCandidate[] = expansions.map((expansion) => ({
        path: expansion.path,
        name: expansion.name,
        directory: expansion.path.split("/").pop() ?? expansion.name,
      }));
      return {
        kind: "selection",
        intent: intent ?? {
          operation: request.operation,
          source: request.source ?? "",
          withdraw: request.withdraw ?? [],
        },
        inventory: {
          source: request.source ?? "",
          kind: "git",
          requestedRef: null,
          resolvedRef: null,
          candidates,
          truncated: false,
          limits: null,
        },
        candidates,
        chosen,
        cursor: 0,
        note: expansions.map((expansion) => expansion.reason).join(" · "),
      };
    },
    [],
  );

  const applyPrepared = useCallback(
    async (prepared: Prepared) => {
      setMode({ kind: "applying", label: `applying ${prepared.proposal.operation}…` });
      try {
        const outcome = await applySkillChange(ctx, prepared.proposal, prepared.proposal.digest);
        if (outcome.status === "refused") {
          onToast?.({
            tone: "err",
            title: "Apply refused",
            body: `${outcome.refusal.code}: ${outcome.refusal.message}`,
          });
          setMode({ kind: "list" });
        } else {
          void ctx.logger?.info(formatTuiEvent(`skills ${prepared.proposal.operation}`, "ok"));
          setMode({ kind: "result", result: outcome.result });
        }
      } catch (err) {
        onToast?.({ tone: "err", title: "Error", body: (err as Error).message });
        setMode({ kind: "list" });
      } finally {
        await prepared.release();
        await refresh();
      }
    },
    [ctx, onToast, refresh],
  );

  // Detail actions per status. `unmanaged` (outside the registry) is not
  // operable: the ownership guard rejects it, so the row is informational.
  const detailActions = useMemo<{ id: ActionId; action: DetailAction }[]>(() => {
    if (!current || current.status === "unmanaged") return [];
    if (current.status === "recommended" || current.status === "registered") {
      const entries: { id: ActionId; action: DetailAction }[] = [
        {
          id: "install",
          action: {
            name: "Install",
            description: `Prepare, preview, then materialize (canonical + ${REPLICA_LABELS}).`,
          },
        },
      ];
      if (current.status === "registered") {
        entries.push({
          id: "remove",
          action: { name: "Remove", description: "Drop from the registry.", danger: true },
        });
      }
      return entries;
    }
    const resolved = resolveSkillSource(current.source, current.ref);
    const gitSource = !("error" in resolved) && resolved.kind === "git";
    const proposed = current.curation?.proposedSource;
    return [
      ...(gitSource
        ? [
            {
              id: "update" as const,
              action: { name: "Update", description: "Re-fetch the registered ref." },
            },
          ]
        : []),
      ...(proposed !== undefined
        ? [
            {
              id: "replace" as const,
              action: {
                name: "Change source",
                description: `Prepare from ${proposed} and show the differences.`,
              },
            },
          ]
        : []),
      {
        id: "repair",
        action: { name: "Repair", description: "Rebuild the host replicas from the canonical." },
      },
      {
        id: "uninstall",
        action: {
          name: "Uninstall",
          description: "Delete canonical + replicas; keeps the registration.",
          danger: true,
        },
      },
      {
        id: "remove",
        action: {
          name: "Remove",
          description: "Uninstall + drop from the registry.",
          danger: true,
        },
      },
    ];
  }, [current]);
  actionsLenRef.current = detailActions.length;

  const triggerAction = useCallback(
    (id: ActionId) => {
      if (!current) return;
      if (id === "uninstall" || id === "remove") {
        setMode({ kind: "confirm", action: id });
        return;
      }
      const request = acquiringRequest(id, current);
      if (request === null) return;
      void prepare(
        request,
        `preparing ${id} of ${current.name}…`,
        request.operation === "replace" && request.source !== undefined
          ? { operation: "replace", source: request.source, withdraw: [current.name] }
          : undefined,
      );
    },
    [current, prepare],
  );

  // input — `t` toggles the list mode (catalog only ↔ every detected skill).
  useInput(
    (input) => {
      if (!isActive || (mode.kind !== "list" && mode.kind !== "detail")) return;
      if (input !== "t" && input !== "T") return;
      reanchorCursor(projectSkills(items, !showAll));
      setShowAll((v) => !v);
    },
    { isActive },
  );

  // input — the source prompt
  useInput(
    (_input, key) => {
      if (!isActive || mode.kind !== "wizard-source") return;
      if (key.escape) setMode({ kind: "list" });
    },
    { isActive },
  );

  // input — selection (↑↓ · space toggles · ⏎ continue · esc cancel)
  useInput(
    (input, key) => {
      if (!isActive || mode.kind !== "selection") return;
      if (key.return) {
        // An empty set keeps the selection with its explanation: continuing
        // with nothing chosen would prepare a proposal about nothing.
        if (mode.chosen.length === 0) {
          return void setMode({ ...mode, note: "Choose at least one skill with [space]." });
        }
        void prepare(
          {
            operation: mode.intent.operation,
            source: mode.intent.source,
            paths: mode.chosen,
            ...(mode.intent.withdraw.length > 0 ? { withdraw: mode.intent.withdraw } : {}),
          },
          `preparing ${mode.chosen.length} skill(s)…`,
          mode.intent,
        );
        return;
      }
      const next = selectionAfterKey(mode, input, key);
      if (next !== null) setMode(next);
    },
    { isActive },
  );

  // input — preview (↑↓ Back/Apply · ⏎ run the focused one · esc back)
  useInput(
    (_input, key) => {
      if (!isActive || mode.kind !== "preview") return;
      if (key.escape) {
        void mode.prepared.release();
        return void setMode({ kind: "list" });
      }
      if (key.upArrow) return void setMode({ ...mode, cursor: 0 });
      if (key.downArrow) return void setMode({ ...mode, cursor: 1 });
      if (key.return) {
        if (mode.cursor === 0) {
          void mode.prepared.release();
          setMode({ kind: "list" });
          return;
        }
        void applyPrepared(mode.prepared);
      }
    },
    { isActive },
  );

  // input — result / recovery
  useInput(
    (input, key) => {
      if (!isActive) return;
      if (mode.kind === "result" && (key.escape || key.return)) {
        return void setMode({ kind: "list" });
      }
      if (mode.kind !== "recovery") return;
      if (key.upArrow) return void setMode({ ...mode, cursor: 0 });
      if (key.downArrow) return void setMode({ ...mode, cursor: 1 });
      const choice = recoveryChoice(input, key.return, mode.cursor);
      if (choice !== null) void resolveJournal(choice);
    },
    { isActive },
  );

  const resolveJournal = useCallback(
    async (choice: "restore" | "discard") => {
      setMode({ kind: "applying", label: `resolving the pending operation (${choice})…` });
      try {
        const outcome = await recoverSkillJournal(ctx, choice);
        if (outcome.status === "refused") {
          onToast?.({ tone: "err", title: "Recovery refused", body: outcome.refusal.message });
          setMode({ kind: "list" });
        } else {
          setMode({ kind: "result", result: outcome.result });
        }
      } catch (err) {
        onToast?.({ tone: "err", title: "Error", body: (err as Error).message });
        setMode({ kind: "list" });
      } finally {
        await refresh();
      }
    },
    [ctx, onToast, refresh],
  );

  const overlayVisible = mode.kind !== "list";
  const home = ctx.env.homeDir();
  const listRangeHint = windowRangeHint(listWindow, visible.length);
  const modeHint = showAll ? "all skills · t show recommended" : "recommended only · t show all";

  return (
    <Box flexDirection="column">
      <PageHead
        title="Skills"
        count={{
          label: `${installedCount} installed${
            unmanagedCount > 0 ? ` · ${unmanagedCount} unmanaged` : ""
          } · ${registeredCount} registered · ${recommendedCount} recommended`,
          tone: installedCount > 0 ? "accent" : "warn",
        }}
        action={<Text color={colors.mute}>~/.agents/skills + host replicas</Text>}
      />

      <SectionHead
        label="Skills"
        count={visible.length}
        hint={listRangeHint ?? modeHint}
        {...(mode.kind === "wizard-source" || mode.kind === "selection"
          ? { rightAction: "esc cancel" }
          : mode.kind === "detail" || mode.kind === "confirm"
            ? { rightAction: "esc to close detail" }
            : {})}
        marginTop={0}
      />

      <Box flexDirection="row">
        <Box flexDirection="column" flexGrow={1} paddingRight={2}>
          {visible.slice(listWindow.start, listWindow.start + listWindow.visible).map((s, i) => {
            const glyph = STATUS_GLYPH[s.status];
            return (
              <ListRow
                key={s.name}
                icon={glyph.glyph}
                iconActive={glyph.active}
                title={s.name}
                subtitle={
                  s.status === "unmanaged" && s.source === ""
                    ? "outside the registry"
                    : `${s.source}${s.ref ? ` #${s.ref}` : ""}`
                }
                meta={rowMeta(s)}
                state={{ label: s.status, tone: glyph.tone }}
                chevron
                active={listWindow.start + i === cursor}
                dimmed={overlayVisible && mode.kind !== "detail" && mode.kind !== "confirm"}
                widthHint={rowWidth(stdout?.columns, overlayVisible)}
              />
            );
          })}

          {mode.kind === "wizard-source" ? (
            <Box flexDirection="column" marginTop={1}>
              <SectionHead
                label="Add skill"
                hint="Step 1 · Source"
                rightAction="⏎ inspect · esc cancel"
              />
              <Box marginLeft={2}>
                <InputPrompt
                  message="source (owner/repo · git URL · absolute path):"
                  onSubmit={(value) => {
                    const source = value.trim();
                    if (!source) {
                      setMode({ kind: "list" });
                      return;
                    }
                    void prepare({ operation: "install", source }, "inspecting source…", {
                      ...mode.intent,
                      source,
                    });
                  }}
                  isActive={isActive}
                />
              </Box>
            </Box>
          ) : null}

          {mode.kind === "selection" ? (
            <SelectionPanel mode={mode} columns={stdout?.columns} />
          ) : null}

          {mode.kind === "preview" ? (
            <PreviewPanel proposal={mode.prepared.proposal} cursor={mode.cursor} home={home} />
          ) : null}

          {mode.kind === "result" ? <ResultPanel result={mode.result} home={home} /> : null}

          {mode.kind === "recovery" ? (
            <RecoveryPanel journal={mode.journal} cursor={mode.cursor} />
          ) : null}

          {mode.kind === "busy" || mode.kind === "applying" ? (
            <Box marginTop={1}>
              <Text color={colors.warn}>
                {icons.spinner} {mode.label}
              </Text>
            </Box>
          ) : null}
        </Box>

        {current && (mode.kind === "detail" || mode.kind === "confirm") ? (
          <DetailPanel
            bordered
            header={{ name: current.name, meta: detailMeta(current, home) }}
            statePill={{
              label: current.status,
              tone:
                current.status === "installed"
                  ? "ok"
                  : current.status === "unmanaged"
                    ? "warn"
                    : "dim",
            }}
            actions={detailActions.map((a) => a.action)}
            focusedAction={actionCursor}
            banner={
              mode.kind === "confirm" ? (
                <ConfirmBanner
                  title={`× ${mode.action === "uninstall" ? "Uninstall" : "Remove"} ${current.name}?`}
                  body={
                    mode.action === "uninstall"
                      ? "Prepares the removal of canonical + replicas; the registration stays. You still approve the preview."
                      : "Prepares the removal and drops the registration. You still approve the preview."
                  }
                />
              ) : null
            }
          />
        ) : null}
      </Box>

      <Box marginTop={1}>
        <QuickActions
          actions={[
            { key: "a", label: "add skill" },
            { key: "t", label: showAll ? "show recommended" : "show all" },
          ]}
        />
      </Box>
    </Box>
  );
}

/** Explicit selection: every eligible skill by name AND location. */
function SelectionPanel({
  mode,
  columns,
}: {
  mode: Extract<Mode, { kind: "selection" }>;
  columns: number | undefined;
}) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <SectionHead
        label="Select skills"
        hint={`${mode.chosen.length} of ${mode.candidates.length} chosen`}
        rightAction="space toggle · ⏎ continue · esc cancel"
      />
      {mode.note !== null ? (
        <Box marginLeft={2}>
          <Text color={colors.warn}>{mode.note}</Text>
        </Box>
      ) : null}
      {mode.inventory.truncated ? (
        <Box marginLeft={2}>
          <Text color={colors.warn}>
            The source walk hit its limit: this list is a floor, not every skill.
          </Text>
        </Box>
      ) : null}
      <Box flexDirection="column">
        {mode.candidates.map((candidate, i) => (
          <ListRow
            key={candidate.path}
            icon={mode.chosen.includes(candidate.path) ? "◆" : "·"}
            iconActive={mode.chosen.includes(candidate.path)}
            title={candidate.name}
            subtitle={candidate.path === "" ? "(source root)" : candidate.path}
            meta={
              candidate.name === candidate.directory
                ? []
                : [{ label: `dir ${candidate.directory}`, tone: "dim" }]
            }
            state={
              mode.chosen.includes(candidate.path)
                ? { label: "chosen", tone: "ok" }
                : { label: "available", tone: "dim" }
            }
            active={mode.cursor === i}
            widthHint={rowWidth(columns, true)}
          />
        ))}
      </Box>
    </Box>
  );
}

/** The whole change before Apply: set, sources, destinations and effects. */
function PreviewPanel({
  proposal,
  cursor,
  home,
}: {
  proposal: SkillChangeProposal;
  cursor: number;
  home: string;
}) {
  const short = (path: string) => path.replace(home, "~");
  return (
    <Box flexDirection="column" marginTop={1}>
      <SectionHead
        label={`Proposed changes · ${proposal.operation}`}
        hint={`${proposal.additions.length} added · ${proposal.withdrawals.length} withdrawn`}
        rightAction="↑↓ choose · ⏎ run · esc back"
      />
      <Box flexDirection="column" marginLeft={2}>
        {proposal.additions.map((skill) => (
          <Text key={skill.name} color={colors.text}>
            + {skill.name}
            <Text color={colors.dim}>
              {" "}
              · {skill.provenance.source}
              {skill.path === "" ? "" : `/${skill.path}`}
              {skill.provenance.resolvedRef === null
                ? ""
                : ` @ ${skill.provenance.resolvedRef.slice(0, 12)}`}
              {" · "}
              {skill.files.length} files
              {skill.manifests.length > 1 ? ` · ${skill.manifests.length} SKILL.md` : ""}
            </Text>
          </Text>
        ))}
        {proposal.withdrawals.map((name) => (
          <Text key={name} color={colors.warn}>
            − {name} <Text color={colors.dim}>· managed installation retired</Text>
          </Text>
        ))}
        <Box marginTop={1} flexDirection="column">
          <Text color={colors.mute}>DESTINATIONS</Text>
          {proposal.destinations.map((destination) => (
            <Text key={`${destination.host}-${destination.location}`} color={colors.dim}>
              {destination.action.padEnd(9)} {destination.host.padEnd(8)}{" "}
              {short(destination.location)}
              {destination.shared ? " · shared" : ""}
              {destination.ownership === "foreign" ? " · foreign, preserved" : ""}
            </Text>
          ))}
        </Box>
        <Box marginTop={1} flexDirection="column">
          <Text color={colors.mute}>EFFECTS · {proposal.effects.join(", ")}</Text>
          {proposal.notes.map((note) => (
            <Text key={note} color={colors.faint}>
              · {note}
            </Text>
          ))}
        </Box>
        <Box marginTop={1} flexDirection="column">
          <Text color={cursor === 0 ? colors.bright : colors.dim}>
            {cursor === 0 ? icons.focusBar : " "} Back
          </Text>
          <Text color={cursor === 1 ? colors.err : colors.dim}>
            {cursor === 1 ? icons.focusBar : " "} Apply
          </Text>
        </Box>
      </Box>
    </Box>
  );
}

/** Per destination: what happened, and — separately — what was checked. */
function ResultPanel({ result, home }: { result: ApplyResult; home: string }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <SectionHead
        label={`Result · ${result.operation}`}
        hint={result.summary}
        rightAction="⏎ back to the list"
      />
      <Box flexDirection="column" marginLeft={2}>
        {result.destinations.map((destination) => (
          <Text key={destination.location} color={colors.dim}>
            <Text color={RESULT_COLOR[destination.status]}>{destination.status.padEnd(10)}</Text>
            {destination.host.padEnd(8)} {destination.location.replace(home, "~")}
            {destination.verification === null
              ? " · not checked"
              : ` · ${destination.verification.passed ? "verified" : "CHECK FAILED"}: ${destination.verification.checked.replace(home, "~")}`}
            {destination.detail === undefined ? "" : ` · ${destination.detail}`}
          </Text>
        ))}
        {result.recovery !== null ? (
          <Box marginTop={1}>
            <Text color={colors.warn}>{result.recovery.action}</Text>
          </Box>
        ) : null}
        {result.cleanup !== null ? (
          <Box marginTop={1}>
            <Text color={colors.faint}>
              Backups pending removal: {result.cleanup.pending.join(", ")}
            </Text>
          </Box>
        ) : null}
        <Box marginTop={1}>
          <Text color={colors.faint}>
            Applied is not "the host loaded it": what is checked above is the bytes this manager
            wrote in the locations it manages.
          </Text>
        </Box>
      </Box>
    </Box>
  );
}

/** An operation a previous run left pending: put it back, or accept and retry. */
function RecoveryPanel({ journal, cursor }: { journal: SkillJournal; cursor: number }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <SectionHead
        label="Unfinished operation"
        hint={`${journal.operation} · ${journal.destinations.length} destination(s)`}
        rightAction="↑↓ choose · ⏎ run"
      />
      <Box flexDirection="column" marginLeft={2}>
        <Text color={colors.warn}>
          A previous run did not finish. Its backups are kept, so the previous state can come back.
        </Text>
        {journal.destinations.map((destination) => (
          <Text key={destination.location} color={colors.dim}>
            {destination.status.padEnd(10)} {destination.location}
          </Text>
        ))}
        <Box marginTop={1} flexDirection="column">
          <Text color={cursor === 0 ? colors.bright : colors.dim}>
            {cursor === 0 ? icons.focusBar : " "} [r] Restore the previous state
          </Text>
          <Text color={cursor === 1 ? colors.bright : colors.dim}>
            {cursor === 1 ? icons.focusBar : " "} [k] Keep the current state and start over
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text color={colors.faint}>
            Neither repeats an effect: a new attempt needs a new proposal.
          </Text>
        </Box>
      </Box>
    </Box>
  );
}

/** Which way out of a pending operation the keystroke asks for. */
function recoveryChoice(
  input: string,
  entered: boolean,
  cursor: number,
): "restore" | "discard" | null {
  if (input === "r" || input === "R") return "restore";
  if (input === "k" || input === "K") return "discard";
  if (!entered) return null;
  return cursor === 0 ? "restore" : "discard";
}

/** Navigation and toggling inside the selection — the state, not the effect. */
function selectionAfterKey(
  mode: Extract<Mode, { kind: "selection" }>,
  input: string,
  key: { escape: boolean; upArrow: boolean; downArrow: boolean },
): Mode | null {
  if (key.escape) return { kind: "list" };
  if (key.upArrow) return { ...mode, cursor: Math.max(0, mode.cursor - 1) };
  if (key.downArrow) {
    return { ...mode, cursor: Math.min(mode.candidates.length - 1, mode.cursor + 1) };
  }
  if (input !== " ") return null;
  const path = mode.candidates[mode.cursor]?.path;
  if (path === undefined) return null;
  return {
    ...mode,
    chosen: mode.chosen.includes(path)
      ? mode.chosen.filter((p) => p !== path)
      : [...mode.chosen, path],
  };
}

/**
 * The request an acquiring action sends to the preparer.
 *
 * The path the catalog reviewed is what makes a NESTED skill reachable; a name
 * is the fallback, and it only resolves while it is unambiguous.
 */
function acquiringRequest(
  id: Exclude<ActionId, "uninstall" | "remove">,
  item: SkillListItem,
): SkillChangeRequest | null {
  const curation = item.curation;
  const where = curation?.path !== undefined ? { paths: [curation.path] } : { pick: item.name };
  if (id === "repair") return { operation: "repair", name: item.name };
  if (id === "install") return { operation: "install", source: item.source, ...where };
  if (id === "update") {
    return {
      operation: "update",
      source: item.source,
      ...(item.ref !== undefined ? { ref: item.ref } : {}),
      ...where,
    };
  }
  // An explicit source change: the previous installation is retired in the
  // SAME proposal that brings the new one.
  const source = curation?.proposedSource;
  if (source === undefined) return null;
  return { operation: "replace", source, withdraw: [item.name], ...where };
}

/** Badges the row carries: the degraded replica, plus a verdict that asks for
 *  a decision (an ordinary keep/conditional row stays quiet). */
function rowMeta(item: SkillListItem): { label: string; tone: MetaTone }[] {
  const meta: { label: string; tone: MetaTone }[] = [];
  if (item.mode === "copy") meta.push({ label: "copy", tone: "warn" });
  const disposition = item.curation?.disposition;
  const tone = disposition ? BADGED_DISPOSITIONS[disposition] : undefined;
  if (disposition && tone) meta.push({ label: DISPOSITION_LABEL[disposition], tone });
  return meta;
}

/** Replica line of an installed/registered/unmanaged row. */
function replicaLine(item: SkillListItem): string {
  return [
    `agents ${item.replicas.agents ? "✓" : "·"}`,
    // `item.mode` describes the FIRST replica host's materialization (symlink
    // vs copy) — the suffix stays on that one, and the host names come from
    // the engine's list instead of being spelled here.
    ...REPLICA_HOST_KEYS.map(
      (key, i) =>
        `${key} ${item.replicas[key] ? "✓" : "·"}${i === 0 && item.mode === "copy" ? " (copy)" : ""}`,
    ),
  ].join(" · ");
}

/** Short form of an inspected revision — enough to compare, never a claim
 *  about what an acquisition would resolve. */
function shortRef(ref: string): string {
  return ref.length > 12 ? ref.slice(0, 12) : ref;
}

/** The reviewed verdict, or the honest absence of one. */
function recommendationLines(curation: SkillCuration | undefined): string[] {
  if (curation === undefined) {
    return [
      "Recommendation: not in the reviewed catalog",
      `Use when: ${UNKNOWN}`,
      `Known limits: ${UNKNOWN}`,
    ];
  }
  const verdict = DISPOSITION_LABEL[curation.disposition];
  return [
    `Recommendation: ${curation.reason ? `${verdict} — ${curation.reason}` : verdict}`,
    `Use when: ${curation.useWhen ?? UNKNOWN}`,
    `Known limits: ${curation.knownLimits ?? UNKNOWN}`,
  ];
}

/** Where the bytes come from — and, when they differ, where a repair would
 *  take them. A divergence is shown, never resolved silently. */
function sourceLines(item: SkillListItem, curation: SkillCuration | undefined): string[] {
  const source = `${item.source === "" ? UNKNOWN : item.source}${item.ref ? ` #${item.ref}` : ""}`;
  const proposed = curation?.proposedSource;
  const lines = [proposed ? `Installed source: ${source}` : `Source: ${source}`];
  if (proposed) lines.push(`Proposed source: ${proposed}`);
  if (curation?.path) lines.push(`Path in source: ${curation.path}`);
  if (curation?.skillName && curation.skillName !== item.name) {
    lines.push(`Catalog name: ${item.name}`, `Skill name: ${curation.skillName}`);
  }
  if (curation?.reviewedRef) lines.push(`Reviewed rev: ${shortRef(curation.reviewedRef)}`);
  if (curation?.evidence) lines.push(`Evidence: ${curation.evidence}`);
  return lines;
}

/**
 * Detail body: installation and recommendation as SEPARATE facts (Spec 043 ·
 * DES-001@r7 / SCR-001@r3#detail). Reading it changes nothing.
 */
function detailMeta(item: SkillListItem, home: string): string {
  const lines: string[] = [];
  if (item.description) lines.push(item.description, "");
  lines.push(
    item.status === "recommended"
      ? "Status: recommended · not installed"
      : `Status: ${item.status} · ${replicaLine(item)}`,
  );
  lines.push(...recommendationLines(item.curation), ...sourceLines(item, item.curation));
  if (item.status !== "recommended") {
    lines.push(`${canonicalSkillsRoot(home)}/${item.name}`.replace(home, "~"));
  }
  if (item.status === "unmanaged") {
    lines.push("Installed outside the registry (e.g. skills.sh) — not operable from here.");
  }
  return lines.join("\n");
}
