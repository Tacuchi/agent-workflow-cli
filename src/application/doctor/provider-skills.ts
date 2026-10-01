import {
  type DoctorCoverage,
  type DoctorFinding,
  doctorFindingId,
} from "../../domain/doctor/model.js";
import { resolveSkills } from "../skills-resolver-service.js";
import type { DoctorProvider, DoctorProviderInput, DoctorProviderOutput } from "./types.js";
import { coverage } from "./types.js";

/** Workline-owned bindings, independent of optional host skills. */
const CATEGORY = "skills" as const;

export const skillsProvider: DoctorProvider = {
  category: CATEGORY,
  async run(input: DoctorProviderInput): Promise<DoctorProviderOutput> {
    const findings: DoctorFinding[] = [];
    const covered: DoctorCoverage[] = [];
    const bindings = await resolveSkills(input.ctx.fs, input.ctx.paths);
    for (const [index, warning] of bindings.warnings.entries()) {
      if (!warning.includes("no aplicable")) continue;
      findings.push({
        id: doctorFindingId("hub", CATEGORY, `binding:${index}`),
        host: "hub",
        category: CATEGORY,
        resource: { kind: "binding", name: `skills.toml:${index}`, locator: null },
        state: "warning",
        summary: "binding histórico no aplicable a Workline",
        impact: "no selecciona herramientas del host",
        evidence: [warning],
        ownership: "foreign",
        remediation: {
          kind: "manual",
          action: null,
          guidance: [
            "gestioná esa skill desde el host o marketplace elegido; el archivo queda intacto",
          ],
        },
      });
    }
    if (bindings.warnings.some((warning) => warning.includes("no aplicable"))) {
      covered.push(coverage(CATEGORY, "hub", "checked"));
    }

    for (const host of input.hosts) {
      covered.push(coverage(CATEGORY, host.host, "checked"));
    }

    return { coverage: covered, findings };
  },
};
