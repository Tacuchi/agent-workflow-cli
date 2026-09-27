import { describe, expect, it } from "vitest";
import "../../src/application/capability/design-handler.js";
import { dispatchCapability } from "../../src/application/capability/dispatcher.js";
import { readClaimEvents } from "../../src/application/claims-ledger.js";
import { readDesignIndex } from "../../src/application/design/design-index-service.js";
import { PathsService } from "../../src/application/paths-service.js";
import type { CapabilityInputValue } from "../../src/domain/capability/protocol.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { MemFs } from "../helpers/mem-fs.js";

const text = (name: string, value: unknown): CapabilityInputValue => ({
  name,
  value,
  provenance: { kind: "text", origin: "caller", seal: null, sensitivity: "public" },
});
const inputs = (title: string) => [text("title", title), text("sources", ["docs/requisitos.md"])];
const context = (fs: MemFs) => ({
  fs,
  env: new FakeEnv("/home", "/work"),
  paths: new PathsService(normalizeNamespace("workflow"), "/home", "/work"),
  workspace: "/work",
  host: "claude-code",
});

describe("design create reserva identidades entre dos preparaciones", () => {
  it("un fallo de publicación conserva la reserva y revierte el diseño parcial", async () => {
    const fs = new MemFs({ lenient: true });
    const author = inputs("Alta de miembro");
    const prepared = await dispatchCapability(
      {
        verb: "prepare",
        capability: "design",
        operation: "create",
        route: "direct",
        inputs: author,
      },
      context(fs),
    );
    if (!prepared.ok) throw new Error("prepare failed");
    const path = "docs/designs/001-design-alta-de-miembro";
    const digest = /input_digest:\s*([a-f0-9]{64})/.exec(
      prepared.attempt.receipt.gaps.join("\n"),
    )?.[1];
    const validated = await dispatchCapability(
      {
        verb: "validate",
        capability: "design",
        operation: "create",
        route: "direct",
        inputs: author,
        answer: JSON.stringify({
          version: 1,
          operation: "design.create",
          input_digest: digest,
          state: "proposed",
          artifacts: [
            {
              path: `${path}/DESIGN.md`,
              content:
                "# Alta de miembro\n\n## Objetivo\n\nAgregar una persona.\n\n## Diseño propuesto\n\nFormulario para el alta.\n\n## Validación\n\nEl alta aparece al guardar.\n",
            },
          ],
        }),
      },
      context(fs),
    );
    if (!validated.ok || validated.attempt.plan === null) throw new Error("validate failed");
    const real = fs.writeTextExclusive.bind(fs);
    fs.writeTextExclusive = async (dest, content) => {
      if (dest.endsWith("/design-manifest.json")) throw new Error("fallo del disco");
      return real(dest, content);
    };
    const plan = validated.attempt.plan;
    const applied = await dispatchCapability(
      {
        verb: "apply",
        capability: "design",
        operation: "create",
        route: "direct",
        request: validated.attempt.request,
        plan,
        approval: { digest: plan.proposal.digest, granted: plan.proposal.requires_approval },
      },
      context(fs),
    );
    expect(applied.ok && applied.attempt.receipt.outcome).toBe("blocked");
    expect(await fs.exists(`/work/${path}/.aw-reservation`)).toBe(true);
    expect(await fs.exists(`/work/${path}/DESIGN.md`)).toBe(false);
  });

  it("una operación con código de sesión atribuye la carpeta a esa sesión", async () => {
    const fs = new MemFs({ lenient: true });
    fs.file(
      "/work/.workflow/sessions/301-uno-plan-exec/SESSION.md",
      "# SESSION\n\n## Objective\nDiseñar\n",
    );
    const result = await dispatchCapability(
      {
        verb: "prepare",
        capability: "design",
        operation: "create",
        route: "direct",
        inputs: [...inputs("Alta de miembro"), text("code", "301")],
      },
      context(fs),
    );
    expect(result.ok && result.attempt.receipt.outcome).toBe("needs_input");
    const ledger = await readClaimEvents(fs, context(fs).paths);
    expect(ledger.events[0]?.claim.owner).toBe("301-uno-plan-exec");
  });

  it("dos títulos distintos obtienen números distintos y el publicado no conserva el marcador", async () => {
    const fs = new MemFs({ lenient: true });
    const one = inputs("Alta de miembro");
    const two = inputs("Baja de miembro");
    const prepared = await Promise.all(
      [one, two].map(async (items) =>
        dispatchCapability(
          {
            verb: "prepare",
            capability: "design",
            operation: "create",
            route: "direct",
            inputs: items,
          },
          context(fs),
        ),
      ),
    );
    expect(
      prepared.every((result) => result.ok && result.attempt.receipt.outcome === "needs_input"),
    ).toBe(true);
    const numbers = prepared.map((result) =>
      result.ok
        ? /docs\/designs\/(\d+)-design-/.exec(result.attempt.receipt.gaps.join("\n"))?.[1]
        : null,
    );
    expect(new Set(numbers)).toEqual(new Set(["001", "002"]));
    expect((await readDesignIndex(fs, "/work")).packages).toEqual([]);

    const path = `docs/designs/${numbers[0]}-design-alta-de-miembro`;
    const body =
      "# Alta de miembro\n\n## Objetivo\n\nAgregar una persona.\n\n## Diseño propuesto\n\nFormulario para el alta.\n\n## Validación\n\nEl alta aparece al guardar.\n";
    const validated = await dispatchCapability(
      {
        verb: "validate",
        capability: "design",
        operation: "create",
        route: "direct",
        inputs: one,
        answer: JSON.stringify({
          version: 1,
          operation: "design.create",
          input_digest: prepared[0]?.ok
            ? /input_digest:\s*([a-f0-9]{64})/.exec(
                prepared[0].attempt.receipt.gaps.join("\n"),
              )?.[1]
            : undefined,
          state: "proposed",
          artifacts: [{ path: `${path}/DESIGN.md`, content: body }],
        }),
      },
      context(fs),
    );
    if (!validated.ok || validated.attempt.plan === null)
      throw new Error(`design validation failed: ${JSON.stringify(validated)}`);
    const plan = validated.attempt.plan;
    const applied = await dispatchCapability(
      {
        verb: "apply",
        capability: "design",
        operation: "create",
        route: "direct",
        request: validated.attempt.request,
        plan,
        approval: { digest: plan.proposal.digest, granted: plan.proposal.requires_approval },
      },
      context(fs),
    );
    expect(applied.ok && applied.attempt.receipt.outcome).toBe("completed");
    expect(await fs.exists(`/work/${path}/.aw-reservation`)).toBe(false);
    expect((await readDesignIndex(fs, "/work")).packages.map((entry) => entry.id)).toEqual([
      `DES-${numbers[0]}`,
    ]);
    expect(
      await fs.exists(`/work/docs/designs/${numbers[1]}-design-baja-de-miembro/.aw-reservation`),
    ).toBe(true);
  });
});
