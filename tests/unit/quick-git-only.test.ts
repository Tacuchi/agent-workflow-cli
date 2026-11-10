// Spec 066, AC-20 y D01: QUICK no crea documento ni sesión; git es su único
// registro. Un QUICK interrumpido se ve sólo en `git status` de su fuente.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DocFlowHub, dataOf, docFlowHub } from "../helpers/doc-flow-hub.js";

describe("QUICK con git como único registro", () => {
  let hub: DocFlowHub;
  let app: string;
  const appGit = (...args: string[]) =>
    execFileSync("git", args, { cwd: app, stdio: "pipe" }).toString();
  const args = ["--source", "app", "--message", "fix: redondea el total", "--path", "total.ts"];

  beforeEach(() => {
    hub = docFlowHub();
    app = join(hub.root, "..", "app");
    mkdirSync(app);
    appGit("init", "-q", "-b", "main");
    appGit("config", "user.email", "t@example.invalid");
    appGit("config", "user.name", "t");
    writeFileSync(join(app, "total.ts"), "export const total = 1.004;\n");
    appGit("add", ".");
    appGit("commit", "-q", "-m", "base");
  });
  afterEach(() => hub.dispose());

  it("un QUICK interrumpido se ve sólo en git status y no deja nada en el hub", () => {
    writeFileSync(join(app, "total.ts"), "export const total = 1.0;\n");
    const proposal = hub.aw(["flow", "propose-commit", ...args]);
    expect(proposal.status, JSON.stringify(proposal.json)).toBe(0);
    // La conversación se corta aquí: nadie aprobó.
    expect(appGit("status", "--porcelain").trim()).toBe("M total.ts");
    expect(hub.changed()).toEqual([]);
    expect(hub.sessionResidue()).toEqual([]);
  });

  it("al aprobarse, el commit y su mensaje son todo el registro", () => {
    writeFileSync(join(app, "total.ts"), "export const total = 1.0;\n");
    const approval = dataOf(hub.aw(["flow", "propose-commit", ...args]).json).approval as string;
    const committed = hub.aw(["flow", "commit", ...args, "--approval", approval]);
    expect(committed.status, JSON.stringify(committed.json)).toBe(0);
    expect(appGit("status", "--porcelain").trim()).toBe("");
    expect(appGit("log", "-1", "--format=%s").trim()).toBe("fix: redondea el total");
    expect(hub.changed()).toEqual([]);
    expect(hub.sessionResidue()).toEqual([]);
  });
});
