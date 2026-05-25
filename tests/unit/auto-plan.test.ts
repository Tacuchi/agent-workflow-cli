import { describe, expect, it } from "vitest";
import {
  countAcceptanceCriteria,
  countDeclaredSourcesMentioned,
  estimateEtaHours,
  shouldSkipFullPlan,
} from "../../src/application/auto-plan.js";

describe("countAcceptanceCriteria", () => {
  it("counts items under '## Criterios de aceptación' (Spanish canon)", () => {
    const text = `## Criterios de aceptación
- [ ] foo
- [ ] bar
- [ ] baz
`;
    expect(countAcceptanceCriteria(text)).toBe(3);
  });

  it("counts items under '## Acceptance Criteria' (English canon)", () => {
    const text = `## Acceptance Criteria
- [ ] foo
- [ ] bar
`;
    expect(countAcceptanceCriteria(text)).toBe(2);
  });

  it("counts items under '## Acceptance criteria' (lowercase variant)", () => {
    const text = `## Acceptance criteria
- [ ] foo
- [ ] bar
- [ ] baz
- [ ] qux
`;
    expect(countAcceptanceCriteria(text)).toBe(4);
  });

  it("counts items under '## Success criteria' (analyze template canon)", () => {
    const text = `## Success criteria
- [ ] foo
- [ ] bar
- [ ] baz
`;
    expect(countAcceptanceCriteria(text)).toBe(3);
  });

  it("counts items under '## Criterios de éxito' (Spanish analyze variant)", () => {
    const text = `## Criterios de éxito
- [ ] foo
- [ ] bar
`;
    expect(countAcceptanceCriteria(text)).toBe(2);
  });

  it("counts items under '## Criterios de exito' (unaccented variant)", () => {
    const text = `## Criterios de exito
- [ ] foo
- [ ] bar
`;
    expect(countAcceptanceCriteria(text)).toBe(2);
  });

  it("returns 0 when no recognized header is present", () => {
    const text = `## Some other heading
- foo
- bar
`;
    expect(countAcceptanceCriteria(text)).toBe(0);
  });

  it("stops counting at the next ## heading", () => {
    const text = `## Success criteria
- [ ] foo
- [ ] bar

## Topics
- [ ] not a criterion
`;
    expect(countAcceptanceCriteria(text)).toBe(2);
  });

  it("accepts both bullets '-' and '*'", () => {
    const text = `## Success criteria
- foo
* bar
- baz
`;
    expect(countAcceptanceCriteria(text)).toBe(3);
  });
});

describe("shouldSkipFullPlan — flow short-circuits (analyze doctrine)", () => {
  const richText = `## Question
Investigar dos problemas \`auto-plan-decide\` y \`claude-code-warp\`.

## Context
- \`agent-workflow-cli\`, \`qtc-workflow-plugin\`, \`qtc-plugins-marketplace\` cubren todo.

## Success criteria
- [ ] foo
- [ ] bar
- [ ] baz
`;

  it("flow=analyze without modalidad → skip per doctrine", () => {
    const r = shouldSkipFullPlan(richText, { flow: "analyze" });
    expect(r.decision).toBe("skip");
    expect(r.reason).toMatch(/analyze/i);
  });

  it("flow=analyze modalidad=incident → lite per doctrine", () => {
    const r = shouldSkipFullPlan(richText, { flow: "analyze", modalidad: "incident" });
    expect(r.decision).toBe("lite");
    expect(r.reason).toMatch(/incident/i);
  });

  it("flow=analyze parses modalidad from '## Modality' section if not provided in options", () => {
    const incidentText = `## Modality
incident

## Question
Why did X break?
`;
    const r = shouldSkipFullPlan(incidentText, { flow: "analyze" });
    expect(r.decision).toBe("lite");
  });

  it("flow=analyze with technical modalidad in text → skip", () => {
    const technicalText = `## Modality
technical

## Question
What is the structure of X?
`;
    const r = shouldSkipFullPlan(technicalText, { flow: "analyze" });
    expect(r.decision).toBe("skip");
  });

  it("flow=dev → runs full heuristic (no analyze short-circuit)", () => {
    const r = shouldSkipFullPlan(richText, { flow: "dev" });
    // With many sources mentioned (legacy heuristic), should detect signals.
    expect(["full", "lite"]).toContain(r.decision);
  });

  it("no flow option → backwards-compat heuristic (legacy callers)", () => {
    const r = shouldSkipFullPlan(richText);
    expect(["full", "lite", "skip"]).toContain(r.decision);
    // Specifically: should NOT short-circuit to skip without flow info.
    expect(r.reason).not.toMatch(/analyze/i);
  });
});

describe("countDeclaredSourcesMentioned", () => {
  const aliases = ["agent-workflow", "qtc-workflow-plugin", "qtc-plugins-marketplace"];

  it("returns 0 when aliases list is empty", () => {
    expect(countDeclaredSourcesMentioned("text mentions agent-workflow", [])).toBe(0);
  });

  it("returns 0 when text is empty", () => {
    expect(countDeclaredSourcesMentioned("", aliases)).toBe(0);
  });

  it("counts each alias that appears as a token in the text", () => {
    const text =
      "Toca `agent-workflow` y también `qtc-workflow-plugin`. El marketplace no se modifica.";
    expect(countDeclaredSourcesMentioned(text, aliases)).toBe(2);
  });

  it("counts all 3 when all aliases appear", () => {
    const text = "agent-workflow + qtc-workflow-plugin + qtc-plugins-marketplace cubren todo.";
    expect(countDeclaredSourcesMentioned(text, aliases)).toBe(3);
  });

  it("is case-insensitive on the alias side", () => {
    const text = "Touching AGENT-WORKFLOW only.";
    expect(countDeclaredSourcesMentioned(text, aliases)).toBe(1);
  });

  it("doesn't double-count repeated mentions", () => {
    const text = "agent-workflow agent-workflow agent-workflow";
    expect(countDeclaredSourcesMentioned(text, aliases)).toBe(1);
  });

  it("ignores aliases that are not present", () => {
    const text = "Only agent-workflow appears here.";
    expect(countDeclaredSourcesMentioned(text, aliases)).toBe(1);
  });
});

describe("shouldSkipFullPlan — declaredAliases (semantic source count)", () => {
  const aliases = ["agent-workflow", "qtc-workflow-plugin", "qtc-plugins-marketplace"];

  it("uses semantic count when declaredAliases provided", () => {
    const text = `## Acceptance criteria
- [ ] foo

\`agent-workflow\` only.

Mentions \`claude-code-warp\`, \`docs/referencias/x.md\`, \`auto-plan-decide\`, \`src/application/auto-plan.ts\` — all code identifiers, not sources.
`;
    const r = shouldSkipFullPlan(text, { flow: "dev", declaredAliases: aliases });
    expect(r.metrics?.sources).toBe(1);
  });

  it("flags >=3 only when 3 declared aliases are actually mentioned", () => {
    const text =
      "Toca agent-workflow + qtc-workflow-plugin + qtc-plugins-marketplace. Refactor cross-source.";
    const r = shouldSkipFullPlan(text, { flow: "dev", declaredAliases: aliases });
    expect(r.metrics?.sources).toBe(3);
    expect(r.signals).toContain(">=3 fuentes mencionadas (3)");
  });

  it("legacy path (no declaredAliases) raises threshold to 10 to mitigate false positives", () => {
    const text = `Menciona muchas cosas: \`a-b-c\`, \`d-e-f\`, \`g-h-i\`, \`j-k-l\`. Pero solo es 1 fuente real.`;
    const r = shouldSkipFullPlan(text, { flow: "dev" });
    // 4 matches < 10 → no signal of cross-source
    expect(r.signals.some((s) => s.startsWith(">=3 fuentes"))).toBe(false);
  });

  it("legacy path still flags when matches >= 10 (very large OBJECTIVEs)", () => {
    const text = `\`a-b-c\` \`d-e-f\` \`g-h-i\` \`j-k-l\` \`m-n-o\` \`p-q-r\` \`s-t-u\` \`v-w-x\` \`y-z-aa\` \`bb-cc-dd\` \`ee-ff-gg\``;
    const r = shouldSkipFullPlan(text, { flow: "dev" });
    expect(r.signals.some((s) => s.startsWith(">=10 fuentes"))).toBe(true);
  });
});

describe("estimateEtaHours — recalibrated srcFactor (T4)", () => {
  const baseText = Array(200).fill("palabra").join(" "); // ~200 words → base = 1.0
  const aliases = ["agent-workflow", "qtc-workflow-plugin", "qtc-plugins-marketplace"];

  it("srcFactor = 1.0 when sources = 1", () => {
    const text = `${baseText} agent-workflow`;
    const eta = estimateEtaHours(text, { declaredAliases: aliases });
    expect(eta).toBeCloseTo(1.0, 1);
  });

  it("srcFactor ≈ 1.25 when sources = 2 (coef 0.25, rounded to 1 decimal)", () => {
    const text = `${baseText} agent-workflow qtc-workflow-plugin`;
    const eta = estimateEtaHours(text, { declaredAliases: aliases });
    // Rounded to 1 decimal: 1.25 → 1.3
    expect(eta).toBe(1.3);
  });

  it("srcFactor = 1.5 when sources = 3", () => {
    const text = `${baseText} agent-workflow qtc-workflow-plugin qtc-plugins-marketplace`;
    const eta = estimateEtaHours(text, { declaredAliases: aliases });
    expect(eta).toBeCloseTo(1.5, 1);
  });

  it("caps sources at 4 (srcFactor saturates ≈ 1.75)", () => {
    const aliases6 = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];
    const text = `${baseText} alpha beta gamma delta epsilon zeta`;
    const eta = estimateEtaHours(text, { declaredAliases: aliases6 });
    // 1.75 → rounded to 1 decimal = 1.8
    expect(eta).toBe(1.8);
  });

  it("legacy mode (no declaredAliases) still uses legacy sources count", () => {
    const text = `${baseText} \`agent-workflow\``;
    const eta = estimateEtaHours(text);
    // 1 source in legacy path → srcFactor 1.0
    expect(eta).toBeCloseTo(1.0, 1);
  });

  it("legacy mode with many code-tokens also benefits from cap", () => {
    // legacy heuristic counts backticks/multi-dash → many matches; cap=4 limits damage
    const tokens = Array.from({ length: 20 }, (_, i) => `\`tok-num-${i}\``).join(" ");
    const text = `${baseText} ${tokens}`;
    const eta = estimateEtaHours(text);
    // With cap of 4: srcFactor = 1 + 0.25*3 = 1.75
    expect(eta).toBeLessThanOrEqual(2.0);
  });
});
