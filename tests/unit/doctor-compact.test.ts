import { describe, expect, it } from "vitest";
import { DOCTOR_COMPACT_SCHEMA_VERSION, doctorCommand } from "../../src/cli/commands/doctor.js";
import type { DoctorReport } from "../../src/domain/doctor/model.js";
import {
  COVERAGE,
  blockingReport,
  finding,
  hostLabel,
  hostView,
  reportOf,
} from "../helpers/doctor-report-fixture.js";

function human(report: DoctorReport, detail = false): string {
  const render = doctorCommand.renderHuman;
  if (render === undefined) throw new Error("doctor perdió su proyección humana");
  return render({ ok: true, data: report, exitCode: report.verdict.exit_code }, { detail });
}

// biome-ignore lint/suspicious/noExplicitAny: the compact JSON is read as published data.
function json(report: DoctorReport, detail = false): any {
  const project = doctorCommand.projectJson;
  if (project === undefined) throw new Error("doctor perdió su proyección JSON");
  return JSON.parse(JSON.stringify(project(report, { detail })));
}

/** One finding of each remediation kind, plus a degraded host. */
function mixedReport(): DoctorReport {
  const report = reportOf(
    [
      finding("claude-code", "installation-hosts", "runtime", "healthy"),
      finding("claude-code", "mcps", "workline", "blocking", {
        remediation: {
          kind: "supported",
          action: {
            op: "self.install-mcp",
            args: {},
            effects: ["mutate_overwrite"],
            depends_on: [],
            expected: "healthy",
          },
          guidance: [],
        },
      }),
      finding("codex", "skills", "w:quick", "warning"),
      finding("codex", "mcps", "database", "unverified", {
        remediation: { kind: "none", action: null, guidance: [] },
      }),
      finding("codex", "mcps", "elicitation", "warning", {
        remediation: { kind: "none", action: null, guidance: [] },
      }),
    ],
    COVERAGE,
  );
  return {
    ...report,
    hosts: [
      hostView("claude-code", true, true, [
        { surface: "hooks", status: "degraded", detail: "sin PreCompact" },
        { surface: "mcp", status: "unsupported", detail: "sin MCP" },
      ]),
      hostView("codex", false, false),
    ],
  };
}

describe("aw doctor por defecto — primero el veredicto, sólo lo que pide acción", () => {
  it("la primera línea es el veredicto y el código de salida no cambia", () => {
    const report = blockingReport();
    const [first, second] = human(report).split("\n");
    expect(first).toBe(`Veredicto: salida 1 — ${report.verdict.reason}`);
    expect(second).toContain("accionable");
    expect(report.verdict.exit_code).toBe(1);
  });

  it("no salen hallazgos sanos ni evidencia sin --detail", () => {
    const text = human(mixedReport());
    expect(text).not.toContain("claude-code/installation-hosts/runtime");
    expect(text).not.toContain("evidencia:");
    expect(text).not.toContain("impacto:");
  });

  it("una línea por host, con su conteo de degradaciones y la línea sin rastro", () => {
    const text = human(mixedReport());
    expect(text).toContain(`→ ${hostLabel("claude-code")} · ready · 1.2.3 · 2 degradaciones`);
    expect(text).toContain(`  ${hostLabel("codex")} · degraded`);
    expect(text).not.toContain(`${hostLabel("codex")} · degraded ·`);
    expect(text).not.toContain("hooks degraded —");
    expect(text).toContain("sin rastro en esta máquina: kimi");
  });

  it("cada hallazgo accionable ocupa dos líneas: id — summary, y su acción o su guía", () => {
    const lines = human(mixedReport()).split("\n");
    const blocking = lines.findIndex((line) => line.includes("claude-code/mcps/workline —"));
    expect(lines[blocking + 1]).toBe("      automatizable · acción: self.install-mcp");
    const manual = lines.findIndex((line) => line.includes("codex/skills/w:quick —"));
    expect(lines[manual + 1]).toBe("      manual · guía: revisá w:quick a mano");
  });

  it("los no sanos sin remediación se colapsan en una línea con su conteo y la pista --detail", () => {
    const text = human(mixedReport());
    expect(text).toContain(
      "2 hallazgo(s) sin acción segura (1 unverified · 1 warning) — detalle con --detail",
    );
    expect(text).not.toContain("codex/mcps/database");
  });

  it("de la cobertura sólo salen las filas que no están comprobadas", () => {
    const text = human(mixedReport());
    expect(text).toContain("mcps · codex: omitida — se pidió --skip-native");
    expect(text).toContain("skills · codex: no aplica — el host no descubre skills");
    expect(text).not.toContain("installation-hosts · claude-code: comprobada");
  });

  it("el JSON por defecto tiene el mismo alcance, con schema_version 3 y sin colecciones vacías", () => {
    const body = json(mixedReport());
    expect(body.schema_version).toBe(DOCTOR_COMPACT_SCHEMA_VERSION);
    expect(DOCTOR_COMPACT_SCHEMA_VERSION).toBe(3);
    expect(body.verdict).toEqual(mixedReport().verdict);
    expect(body.hosts).toEqual([
      {
        host: "claude-code",
        label: hostLabel("claude-code"),
        status: "ready",
        version: "1.2.3",
        degradations_count: 2,
      },
      { host: "codex", label: hostLabel("codex"), status: "degraded", version: null },
    ]);
    expect(body.findings.map((item: { id: string }) => item.id)).toEqual([
      "claude-code/mcps/workline",
      "codex/skills/w:quick",
    ]);
    expect(body.findings.every((item: object) => !("evidence" in item))).toBe(true);
    expect(body.collapsed).toEqual({ count: 2, by_state: { unverified: 1, warning: 1 } });
    expect(body.coverage.every((entry: { state: string }) => entry.state !== "checked")).toBe(true);
    const quiet = json(reportOf([finding("claude-code", "skills", "x", "healthy")], []));
    expect(Object.keys(quiet).sort()).toEqual([
      "cli_version",
      "hosts",
      "hosts_absent",
      "schema_version",
      "scope",
      "summary",
      "verdict",
    ]);
  });

  it("--detail es el informe completo de hoy, en humano y en JSON", () => {
    const report = mixedReport();
    expect(json(report, true)).toEqual(JSON.parse(JSON.stringify(report)));
    const text = human(report, true);
    expect(text.split("\n")[0]).toBe("Hosts");
    expect(text).toContain("hooks degraded — sin PreCompact");
    expect(text).toContain("evidencia:");
    expect(text).toContain("claude-code/installation-hosts/runtime");
  });
});
