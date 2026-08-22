/**
 * The per-host structured-choice binding, rendered as the text an installed
 * surface carries.
 *
 * Why a stamp at all: the canonical bundle is host-neutral on purpose, and the CLI
 * does not present — it emits directives and a surface shows them. So the only
 * thing that ever knew which host it was talking about was the INSTALL, and it was
 * throwing that away: every wrapper on every host shipped the same neutral
 * sentence, and an agent reading it had nothing telling it which mechanism to
 * reach for. Runtime detection is not the answer either — `aw harness` legitimately
 * answers `unknown` inside Kimi Code, which exports no env marker.
 *
 * So the binding is stamped at install, when the target IS known, and it is
 * generated from {@link HarnessSpec.structuredChoice} and nothing else — a second
 * hand-written copy per host is exactly the drift the catalog exists to prevent.
 *
 * It stays short by design. Every byte here lands in EVERY installed wrapper on
 * that host and is read on every invocation, so this is a context cost, not free
 * documentation: it says which mechanism, its ceilings, where the sentence goes,
 * and when to fall back. The reasoning behind the rule lives in `HARNESS.md`.
 */

import { type HarnessSpec, type InstallTarget, harnessByInstallTarget } from "./harnesses.js";

/**
 * The universal floor, spelled the same way on every host — including the ones
 * that reach it as a fallback. Kept in one constant so a host that degrades and a
 * host that never had a mechanism describe the same thing identically: two
 * wordings would read as two different fallbacks.
 */
const LABELED_MARKDOWN =
  "labeled markdown — every option as `Label — functional sentence`, the `flow` control (`Compactar`/`Cerrar`) always among them, answered by label or `Aceptar recomendaciones`";

const CONTENT_RULE =
  "Degrade the mechanism, never the content: no alternative is merged, truncated or dropped to fit, and any loss is declared as a degradation.";

/**
 * The stamp for one host, as a markdown blockquote (no trailing newline).
 *
 * A blockquote because it is inserted into documents whose own body is markdown —
 * a command wrapper, a synthesized skill, a capability skill — and a quote block
 * reads as "this is about your host", not as another step of the procedure.
 */
export function renderStructuredChoiceStamp(spec: HarnessSpec): string {
  const binding = spec.structuredChoice;
  const lines = [
    `**Structured-choice on this host (\`${spec.installTarget}\`, stamped at install).**`,
  ];

  if (binding.state === "native" && binding.tool !== null) {
    lines[0] += ` Present every human and authorization boundary with \`${binding.tool}\`${ceilingClause(binding.ceilings)}.`;
    // The forcing sentence: on a host whose own prompt nudges toward prose, the
    // boundary's options are content, and prose silently drops them.
    lines.push("While it is reachable, never render a boundary as plain prose instead.");
    lines.push(sentenceClause(binding.sentence, binding.sentenceMaxChars));
    if (binding.customAnswer) {
      lines.push(
        "It already offers a free-text answer, so do not add an `Other` option of your own.",
      );
    }
    // The condition leads: a reader who stops at the comma still knows WHEN this
    // applies. Trailing it after the fallback's own long description buried it.
    lines.push(`When ${binding.fallbackReason}, fall back to ${LABELED_MARKDOWN}.`);
  } else if (binding.state === "degraded" && binding.tool !== null) {
    // Degraded ≠ denied: the mechanism exists and some turns really offer it, so
    // the stamp orders using it exactly then — which self-heals the day the host
    // lists it more often — and names when (and why) markdown takes over.
    lines[0] += ` Its \`${binding.tool}\` is not always offered: whenever the current turn lists it among the available tools, present every human and authorization boundary with it${ceilingClause(binding.ceilings)}.`;
    lines.push(sentenceClause(binding.sentence, binding.sentenceMaxChars));
    if (binding.customAnswer) {
      lines.push(
        "It already offers a free-text answer, so do not add an `Other` option of your own.",
      );
    }
    lines.push(`When ${binding.fallbackReason}, fall back to ${LABELED_MARKDOWN}.`);
    // A degraded host's own prompt tends to prefer prose exactly where the tool is
    // missing (codex: "never write a multiple choice question as a textual
    // assistant message") — and prose silently drops the alternatives.
    lines.push(
      "Even where this host's own guidance prefers a plain-text question, a Workline boundary still presents every option.",
    );
  } else {
    lines[0] += ` Present every human and authorization boundary as ${LABELED_MARKDOWN}.`;
    lines.push(`This host exposes no native selection surface: ${binding.fallbackReason}.`);
  }

  lines.push(CONTENT_RULE);
  return lines.map((line) => `> ${line}`).join("\n");
}

/**
 * The stamp for an install target, host or shared destination.
 *
 * A shared skills dir is read by several hosts at once, so stamping one host's tool
 * into it would name the wrong mechanism for every other reader. It gets the
 * guaranteed floor plus where to resolve its own column — which is the honest
 * answer, and the only one that cannot be wrong.
 */
export function stampForInstallTarget(target: InstallTarget): string {
  const spec = harnessByInstallTarget(target);
  if (spec !== null) return renderStructuredChoiceStamp(spec);
  return [
    `> **Structured-choice on this host (\`${target}\` is a shared skills dir, stamped at install).**`,
    "> Several hosts read this directory, so no single native mechanism can be named here.",
    `> Present every human and authorization boundary as ${LABELED_MARKDOWN}; if the host you`,
    "> are actually running in has a native surface, its column in `harness/HARNESS.md` §",
    "> *Harness binding matrix* is the one to follow.",
    `> ${CONTENT_RULE}`,
  ].join("\n");
}

/**
 * A ceiling the host declares, or the explicit absence of one.
 *
 * The absent case does not fall silent: with no host ceiling the chassis' own
 * `≤3 content questions` is what applies, and an agent told nothing would either
 * invent a limit or ignore both.
 */
function ceilingClause(ceilings: { questions: number; options: number } | null): string {
  const flowSlot =
    ", always reserving one question slot for the `flow` control (`Compactar`/`Cerrar`)";
  if (ceilings === null) {
    return `, whose per-call ceilings this host does not declare — keep the chassis' ≤3 content questions${flowSlot}`;
  }
  return `, at most ${ceilings.questions} questions per call and ${ceilings.options} options each${flowSlot}`;
}

/** Where the option's functional sentence goes, and whether the host caps it. */
function sentenceClause(sentence: "field" | "in-label", maxChars: number | null): string {
  const cap =
    maxChars === null
      ? ""
      : ` This host caps that sentence at ${maxChars} characters: a consequence that does not fit is a degradation to declare, never a sentence to trim.`;
  return sentence === "field"
    ? `The option's label and its functional sentence go in their own fields.${cap}`
    : `This host shows one visible option string, so render \`Label — functional sentence\`.${cap}`;
}
