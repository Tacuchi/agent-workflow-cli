import { join } from "node:path";
import type { PlanExecBatch } from "../domain/flow/run-state.js";
import { canonicalEol } from "../domain/proposal.js";
import { scanMarkdown } from "./markdown.js";
import type { BatchPhaseUpdate } from "./plan-exec-batch-service.js";

const PHASE = /^\s*###\s+F(\d+)\b/;
const STATE = /^\s*>\s*Estado\s*:\s*.*$/i;
const BLOCKER = /^\s*>\s*Bloqueo\s*:\s*.*$/i;
const BOX = /^(\s*[-*]\s*)\[([ xX])\](\s+.*)$/;
const TASK = /^\s*(T\d+\.\d+)\b/;

export function sealedPlanPath(sessionDir: string, digest: string): string {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("digest del plan inválido");
  return join(sessionDir, ".plan-seals", `${digest}.md`);
}

/** Only a batch's own checkboxes and the phase marks it writes can drift. */
export function batchMarksOnly(
  sealed: string,
  current: string,
  batch: PlanExecBatch,
  updates: readonly BatchPhaseUpdate[],
): boolean {
  const original = scanMarkdown(canonicalEol(sealed));
  const phaseLines = new Map<number, { state?: string; blocker?: string }>();
  let phase: number | null = null;
  let inTasks = false;
  const headings = new Map(original.headings.map((heading) => [heading.line, heading]));
  for (const [index, line] of original.lines.entries()) {
    if (original.fenced[index]) continue;
    const heading = headings.get(index);
    if (heading !== undefined && heading.level <= 2) {
      inTasks = heading.level === 2 && heading.title.toLowerCase() === "tasks";
      phase = null;
    }
    if (heading?.level === 3) phase = inTasks ? Number(PHASE.exec(line)?.[1]) || null : null;
    if (phase === null || !batch.phases.includes(phase)) continue;
    const marks = phaseLines.get(phase) ?? {};
    if (STATE.test(line) && marks.state === undefined) marks.state = line;
    if (BLOCKER.test(line) && marks.blocker === undefined) marks.blocker = line;
    phaseLines.set(phase, marks);
  }

  const mask = (text: string, live: boolean): string => {
    let owner: number | null = null;
    let tasks = false;
    const scanned = scanMarkdown(canonicalEol(text));
    const byLine = new Map(scanned.headings.map((heading) => [heading.line, heading]));
    return scanned.lines
      .flatMap((line, index) => {
        if (scanned.fenced[index]) return [line];
        const heading = byLine.get(index);
        if (heading !== undefined && heading.level <= 2) {
          tasks = heading.level === 2 && heading.title.toLowerCase() === "tasks";
          owner = null;
        }
        if (heading?.level === 3) owner = tasks ? Number(PHASE.exec(line)?.[1]) || null : null;
        if (owner === null || !batch.phases.includes(owner)) return [line];
        const box = BOX.exec(line);
        if (box !== null && batch.tasks.includes(TASK.exec(box[3] ?? "")?.[1] ?? "")) {
          return [`${box[1]}[*]${box[3]}`];
        }
        const expected = phaseLines.get(owner);
        const update = updates.find((item) => item.phase === owner);
        if (STATE.test(line) && expected?.state !== undefined) {
          if (!live || line === expected.state || line === `> Estado: ${update?.state}`) {
            return ["> Estado: <batch>"];
          }
        }
        if (BLOCKER.test(line)) {
          if (update?.blocker === undefined) return [line];
          const target =
            typeof update?.blocker === "string" ? `> Bloqueo: ${update.blocker}` : null;
          if (
            (expected?.blocker !== undefined || target !== null) &&
            (!live || line === expected?.blocker || line === target)
          )
            return [];
        }
        return [line];
      })
      .join("\n");
  };
  return mask(sealed, false) === mask(current, true);
}

/** A small bounded line-by-line rejection diff; EOL-only lines get their own mark. */
export function planLineDiff(sealed: string, current: string): string {
  const before = sealed.split("\n");
  const after = current.split("\n");
  const changes: string[] = [];
  for (let i = 0; i < Math.max(before.length, after.length) && changes.length < 30; i += 1) {
    const old = before[i];
    const now = after[i];
    if (old === now) continue;
    if (old?.replace(/\r$/, "") === now?.replace(/\r$/, "")) {
      changes.push(`L${i + 1} ~ fin de línea (CRLF/LF)`);
    } else {
      const ending =
        old !== undefined && now !== undefined && old.endsWith("\r") !== now.endsWith("\r")
          ? " (también fin de línea CRLF/LF)"
          : "";
      changes.push(
        `L${i + 1}${ending} - ${old ?? "<sin línea>"}\nL${i + 1} + ${now ?? "<sin línea>"}`,
      );
    }
  }
  return changes.join("\n") || "sin diferencias de líneas";
}
